import { env } from "cloudflare:workers";
import { and, desc, eq, isNotNull, inArray } from "drizzle-orm";
import { ensureBenchmarkSchema, getD1, getDb } from "../../../db";
import { benchmarkRuns, protocolQuotes } from "../../../db/schema";
import { runSelectedBenchmark } from "../../../lib/quotes/run";
import type { ExecutionMode } from "../../../lib/quotes/types";
import { publicCacheHeaders, readPublicCache, writePublicCache } from "../../../lib/http-cache";

function executionMode(value: unknown): ExecutionMode {
  return value === "optimized" ? "optimized" : "standard";
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
    if (!routeId || !amountId) return Response.json({ error: "routeId and amountId are required" }, { status: 400 });

    const db = getDb();
    const [run] = await db.select().from(benchmarkRuns)
      .where(and(
        eq(benchmarkRuns.pairId, routeId),
        eq(benchmarkRuns.amountId, amountId),
        eq(benchmarkRuns.mode, mode),
        isNotNull(benchmarkRuns.completedAt),
        inArray(benchmarkRuns.status, ["complete", "partial"]),
      ))
      .orderBy(desc(benchmarkRuns.initiatedAt), desc(benchmarkRuns.id)).limit(1);
    if (!run) return writePublicCache(request, Response.json({ run: null, quotes: [] }, { headers: publicCacheHeaders(60) }));

    const quotes = await db.select().from(protocolQuotes)
      .where(eq(protocolQuotes.runId, run.id))
      .orderBy(protocolQuotes.requestStartedAt, protocolQuotes.id);
    const payloads = await getD1().prepare(`
      SELECT protocol, request_url AS requestUrl, request_payload_json AS requestPayloadJson,
        raw_response_json AS rawResponseJson, error_message AS payloadErrorMessage
      FROM latest_quote_payloads
      WHERE run_id = ? AND pair_id = ? AND amount_id = ? AND mode = ?
    `).bind(run.id, routeId, amountId, mode).all<{
      protocol: string;
      requestUrl: string | null;
      requestPayloadJson: string | null;
      rawResponseJson: string | null;
      payloadErrorMessage: string | null;
    }>();
    const payloadByProtocol = new Map(payloads.results.map((payload) => [payload.protocol, payload]));
    return writePublicCache(request, Response.json({
      run,
      quotes: quotes.map((quote) => {
        const payload = payloadByProtocol.get(quote.protocol);
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
