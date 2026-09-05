import { env } from "cloudflare:workers";
import { and, desc, eq, isNotNull, inArray } from "drizzle-orm";
import { ensureBenchmarkSchema, getD1, getDb } from "../../../db";
import { benchmarkRuns, protocolQuotes } from "../../../db/schema";
import { runSelectedBenchmark, type BenchmarkArchiveRecord } from "../../../lib/quotes/run";
import { rawArchiveRetentionMs } from "../../../lib/quotes/retention";
import type { ExecutionMode } from "../../../lib/quotes/types";
import type { ThorDepthForecast } from "../../../lib/quotes/depth-forecast";
import { publicCacheHeaders, readPublicCache, writePublicCache } from "../../../lib/http-cache";

function executionMode(value: unknown): ExecutionMode {
  return value === "optimized" ? "optimized" : "standard";
}

type StoredRun = typeof benchmarkRuns.$inferSelect;
type StoredPayload = {
  protocol: string;
  requestUrl: string | null;
  requestPayloadJson: string | null;
  rawResponseJson: string | null;
  payloadErrorMessage: string | null;
};
type NavigationTarget = { runId: number; initiatedAt: string };
type NavigationRow = NavigationTarget & { direction: "previous" | "next" };

function serialized(value: unknown) {
  return value == null ? null : JSON.stringify(value, null, 2);
}

function parsedDepthForecast(value: string | null) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as { modelVersion?: string; status?: string };
    return (parsed.modelVersion === "thor-depth-v1" || parsed.modelVersion === "thor-depth-v2" || parsed.modelVersion === "thor-depth-v3") && (parsed.status === "available" || parsed.status === "unavailable")
      ? parsed as ThorDepthForecast
      : null;
  } catch {
    return null;
  }
}

async function archivedPayloads(run: StoredRun) {
  const empty = { available: false, payloads: new Map<string, StoredPayload>() };
  if (!run.sweepId || run.bundleIndex == null) return empty;
  const bundle = await getD1().prepare(`
    SELECT raw_archive_key AS rawArchiveKey
    FROM collector_bundles
    WHERE sweep_id = ? AND bundle_index = ?
  `).bind(run.sweepId, run.bundleIndex).first<{ rawArchiveKey: string | null }>();
  const archiveBucket = (env as unknown as { ARCHIVE?: R2Bucket }).ARCHIVE;
  if (!bundle?.rawArchiveKey || !archiveBucket) return empty;
  try {
    const object = await archiveBucket.get(bundle.rawArchiveKey);
    if (!object) return empty;
    const stream = object.body.pipeThrough(new DecompressionStream("gzip"));
    const archive = await new Response(stream).json() as { records?: BenchmarkArchiveRecord[] };
    const record = archive.records?.find((candidate) => candidate.runId === run.id);
    if (!record) return empty;
    return {
      available: true,
      payloads: new Map(record.quotes.map((quote): [string, StoredPayload] => [quote.protocol, {
        protocol: quote.protocol,
        requestUrl: quote.requestUrl ?? null,
        requestPayloadJson: serialized(quote.requestPayload),
        rawResponseJson: serialized(quote.rawResponse),
        payloadErrorMessage: quote.errorMessage ?? null,
      }])),
    };
  } catch (error) {
    console.warn("Unable to read archived quote payloads", { runId: run.id, error });
    return empty;
  }
}

async function availableNavigation(run: StoredRun) {
  const cutoff = new Date(Date.now() - rawArchiveRetentionMs).toISOString();
  const result = await getD1().prepare(`
    WITH available_runs AS (
      SELECT r.id AS runId, r.initiated_at AS initiatedAt
      FROM benchmark_runs r
      LEFT JOIN collector_bundles b
        ON b.sweep_id = r.sweep_id AND b.bundle_index = r.bundle_index
      WHERE r.pair_id = ? AND r.amount_id = ? AND r.mode = ?
        AND r.initiated_at >= ?
        AND r.completed_at IS NOT NULL AND r.status IN ('complete', 'partial')
        AND (
          b.raw_archive_key IS NOT NULL
          OR EXISTS (SELECT 1 FROM latest_quote_payloads p WHERE p.run_id = r.id)
        )
    ), previous_run AS (
      SELECT runId, initiatedAt FROM available_runs
      WHERE initiatedAt < ? OR (initiatedAt = ? AND runId < ?)
      ORDER BY initiatedAt DESC, runId DESC LIMIT 1
    ), next_run AS (
      SELECT runId, initiatedAt FROM available_runs
      WHERE initiatedAt > ? OR (initiatedAt = ? AND runId > ?)
      ORDER BY initiatedAt, runId LIMIT 1
    )
    SELECT 'previous' AS direction, runId, initiatedAt FROM previous_run
    UNION ALL
    SELECT 'next' AS direction, runId, initiatedAt FROM next_run
  `).bind(
    run.pairId, run.amountId, run.mode, cutoff,
    run.initiatedAt, run.initiatedAt, run.id,
    run.initiatedAt, run.initiatedAt, run.id,
  ).all<NavigationRow>();
  const targets = new Map(result.results.map((target) => [target.direction, {
    runId: Number(target.runId),
    initiatedAt: target.initiatedAt,
  }]));
  return {
    previous: targets.get("previous") ?? null,
    next: targets.get("next") ?? null,
  };
}

export async function GET(request: Request) {
  try {
    const cached = await readPublicCache(request);
    if (cached) return cached;
    await ensureBenchmarkSchema();
    const url = new URL(request.url);
    const routeId = url.searchParams.get("routeId")?.trim();
    const amountId = url.searchParams.get("amountId")?.trim();
    const mode = executionMode(url.searchParams.get("mode"));
    const requestedRunId = Number(url.searchParams.get("runId"));
    const hasRunId = Number.isInteger(requestedRunId) && requestedRunId > 0;
    if (!hasRunId && (!routeId || !amountId)) return Response.json({ error: "routeId and amountId are required" }, { status: 400 });

    const db = getDb();
    const [run] = hasRunId
      ? await db.select().from(benchmarkRuns).where(and(
          eq(benchmarkRuns.id, requestedRunId),
          isNotNull(benchmarkRuns.completedAt),
          inArray(benchmarkRuns.status, ["complete", "partial"]),
        )).limit(1)
      : await db.select().from(benchmarkRuns)
          .where(and(
            eq(benchmarkRuns.pairId, routeId!),
            eq(benchmarkRuns.amountId, amountId!),
            eq(benchmarkRuns.mode, mode),
            isNotNull(benchmarkRuns.completedAt),
            inArray(benchmarkRuns.status, ["complete", "partial"]),
          ))
          .orderBy(desc(benchmarkRuns.initiatedAt), desc(benchmarkRuns.id)).limit(1);
    if (!run) return writePublicCache(request, Response.json({ run: null, quotes: [] }, { headers: publicCacheHeaders(60) }));

    const [quotes, payloads, archived, navigation] = await Promise.all([
      db.select().from(protocolQuotes)
        .where(eq(protocolQuotes.runId, run.id))
        .orderBy(protocolQuotes.requestStartedAt, protocolQuotes.id),
      getD1().prepare(`
        SELECT protocol, request_url AS requestUrl, request_payload_json AS requestPayloadJson,
          raw_response_json AS rawResponseJson, error_message AS payloadErrorMessage
        FROM latest_quote_payloads
        WHERE run_id = ? AND pair_id = ? AND amount_id = ? AND mode = ?
      `).bind(run.id, run.pairId, run.amountId, run.mode).all<StoredPayload>(),
      hasRunId ? archivedPayloads(run) : Promise.resolve({ available: false, payloads: new Map<string, StoredPayload>() }),
      availableNavigation(run),
    ]);
    const payloadByProtocol = new Map(payloads.results.map((payload) => [payload.protocol, payload]));
    const { depthForecastJson, ...publicRun } = run;
    return writePublicCache(request, Response.json({
      run: publicRun,
      depthForecast: parsedDepthForecast(depthForecastJson),
      rawDetailsAvailable: payloads.results.length > 0 || archived.available,
      navigation,
      quotes: quotes.map((quote) => {
        const payload = payloadByProtocol.get(quote.protocol) ?? archived.payloads.get(quote.protocol);
        return {
          ...quote,
          requestUrl: payload?.requestUrl ?? quote.requestUrl,
          requestPayloadJson: payload?.requestPayloadJson ?? null,
          rawResponseJson: payload?.rawResponseJson ?? null,
          errorMessage: payload?.payloadErrorMessage ?? quote.errorMessage,
        };
      }),
    }, { headers: publicCacheHeaders(60) }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Quote history unavailable";
    if (message.includes("no such table") || message.includes("no such column")) {
      return Response.json({ run: null, quotes: [], migrationPending: true });
    }
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const configuredToken = (env as unknown as { COLLECTOR_ADMIN_TOKEN?: string }).COLLECTOR_ADMIN_TOKEN;
    const suppliedToken = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (!configuredToken || suppliedToken !== configuredToken) return Response.json({ error: "Not found" }, { status: 404 });
    const body = await request.json() as { routeId?: string; amountId?: string; mode?: string };
    const routeId = body.routeId?.trim();
    const amountId = body.amountId?.trim();
    if (!routeId || !amountId) return Response.json({ error: "routeId and amountId are required" }, { status: 400 });
    const result = await runSelectedBenchmark(routeId, amountId, executionMode(body.mode));
    return Response.json(result, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Benchmark run failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
