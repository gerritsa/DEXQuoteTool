import { ensureBenchmarkSchema, getD1 } from "../../../db";
import { publicCacheHeaders, readPublicCache, writePublicCache } from "../../../lib/http-cache";
import { bestOutputMode } from "../../../lib/quotes/protocols";
import { completedQuoteBatch } from "../../../lib/quotes/latest";

type PartnerId = "thorchain" | "chainflip" | "near-intents" | "maya";
type TrendBucketRow = { bucketStart: string; samplesJson: string };
type AvailabilityRow = { protocol: PartnerId; attempts: number; successes: number };
type StoredQuote = { protocol: PartnerId; output: number; oracleGapBps: number };
type StoredRun = { runId: number; initiatedAt: string; quotes: StoredQuote[] };
type RunRevision = { runId: number; initiatedAt: string };
type ScoredRow = {
  runId: number;
  initiatedAt: string;
  timestamp: number;
  protocol: PartnerId;
  oracleGapBps: number;
  winCredit: number;
};

const protocols: PartnerId[] = ["near-intents", "chainflip", "thorchain", "maya"];
const metricProtocolOrder: PartnerId[] = ["thorchain", "chainflip", "near-intents", "maya"];
const expectedCollectionIntervalMs = 30 * 60 * 1000;

async function resolveRunRevision(routeId: string, amountId: string, requestedRunId: number) {
  return completedQuoteBatch(getD1(), routeId, amountId,
    Number.isSafeInteger(requestedRunId) && requestedRunId > 0 ? requestedRunId : null, true);
}

async function loadRecentRuns(routeId: string, amountId: string, revision: RunRevision, startAt: number, storedRuns: StoredRun[]) {
  const latestAt = Date.parse(revision.initiatedAt);
  const archivedAt = Math.max(startAt, ...storedRuns.map((run) => Date.parse(run.initiatedAt)).filter(Number.isFinite));
  // Only read the unarchived tail, with one overlapping check for deduplication.
  // A 24-hour/64-batch ceiling also bounds reads if sweep publication stalls.
  const tailStart = Math.max(startAt, latestAt - 24 * 60 * 60 * 1000, archivedAt - expectedCollectionIntervalMs);
  const result = await getD1().prepare(`WITH recent_runs AS (
    SELECT id, initiated_at FROM benchmark_runs
    WHERE pair_id = ? AND amount_id = ? AND created_at >= ? AND mode = ?
      AND initiated_at >= ? AND initiated_at <= ? AND id <= ?
      AND oracle_captured_at IS NOT NULL AND completed_at IS NOT NULL AND status IN ('complete', 'partial')
    ORDER BY created_at DESC, id DESC LIMIT 64
  ) SELECT r.id AS runId, r.initiated_at AS initiatedAt,
    json_group_array(json_object('protocol', q.protocol,
      'output', CAST(q.expected_output_formatted AS REAL), 'oracleGapBps', q.oracle_gap_bps)) AS quotesJson
    FROM recent_runs r LEFT JOIN protocol_quotes q ON q.run_id = r.id
      AND q.status = 'quoted' AND CAST(q.expected_output_formatted AS REAL) > 0 AND q.oracle_gap_bps IS NOT NULL
    GROUP BY r.id, r.initiated_at`)
    .bind(routeId, amountId, new Date(tailStart - 60_000).toISOString().replace('T', ' ').slice(0, 19), bestOutputMode,
      new Date(tailStart).toISOString(), revision.initiatedAt, revision.runId)
    .all<RunRevision & { quotesJson: string }>();
  return result.results.flatMap((run) => parseStoredRuns(JSON.stringify([{ ...run, quotes: JSON.parse(run.quotesJson) }])));
}

function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function parseStoredRuns(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((run): StoredRun[] => {
      if (!run || typeof run !== "object") return [];
      const candidate = run as Partial<StoredRun>;
      if (typeof candidate.runId !== "number" || typeof candidate.initiatedAt !== "string" || !Array.isArray(candidate.quotes)) return [];
      const quotes = candidate.quotes.flatMap((quote): StoredQuote[] => {
        if (!quote || typeof quote !== "object") return [];
        const storedQuote = quote as Partial<StoredQuote>;
        if (!storedQuote.protocol || !protocols.includes(storedQuote.protocol)
          || storedQuote.oracleGapBps == null || storedQuote.output == null
          || !Number.isFinite(Number(storedQuote.output)) || !Number.isFinite(Number(storedQuote.oracleGapBps))) return [];
        return [{ protocol: storedQuote.protocol, output: Number(storedQuote.output), oracleGapBps: Number(storedQuote.oracleGapBps) }];
      });
      return [{ runId: candidate.runId, initiatedAt: candidate.initiatedAt, quotes }];
    });
  } catch {
    return [];
  }
}

function scoreRuns(storedRuns: StoredRun[], selectedProtocols: PartnerId[], startAt: number, endAt: number) {
  const selected = new Set(selectedProtocols);
  const rows: ScoredRow[] = [];
  for (const run of storedRuns) {
    const timestamp = new Date(run.initiatedAt).getTime();
    if (!Number.isFinite(timestamp) || timestamp < startAt || timestamp > endAt) continue;
    const quotes = run.quotes.filter((quote) => selected.has(quote.protocol) && Number.isFinite(Number(quote.output)) && Number(quote.output) > 0);
    if (!quotes.length) continue;
    const bestOutput = Math.max(...quotes.map((quote) => Number(quote.output)));
    if (!bestOutput) continue;
    const winnerCount = quotes.filter((quote) => Number(quote.output) === bestOutput).length;
    for (const quote of quotes) {
      const output = Number(quote.output);
      rows.push({
        runId: run.runId,
        initiatedAt: run.initiatedAt,
        timestamp,
        protocol: quote.protocol,
        oracleGapBps: quote.oracleGapBps,
        winCredit: output === bestOutput ? 1 / winnerCount : 0,
      });
    }
  }
  return rows;
}

async function loadAvailability(
  routeId: string,
  amountId: string,
  selectedProtocols: PartnerId[],
  startAt: string,
) {
  const cutoffDay = startAt.slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  const protocolMask = metricProtocolOrder.filter((protocol) => selectedProtocols.includes(protocol)).join(",");
  const protocolPlaceholders = selectedProtocols.map(() => "?").join(", ");
  const selectedProtocolRows = selectedProtocols.map(() => "SELECT ? AS protocol").join(" UNION ALL ");
  const result = await getD1().prepare(`
    WITH selected_protocols AS (
      ${selectedProtocolRows}
    ), aggregate_metrics AS (
      SELECT p.protocol,
        SUM(COALESCE(CAST(json_extract(d.metrics_json, '$.p."' || p.protocol || '"[0]') AS INTEGER), 0)) AS attempts,
        SUM(COALESCE(CAST(json_extract(d.metrics_json, '$.p."' || p.protocol || '"[1]') AS INTEGER), 0)) AS successes
      FROM daily_comparison_metrics d
      CROSS JOIN selected_protocols p
      WHERE d.pair_id = ? AND d.amount_id = ? AND d.mode = ?
        AND d.day > ? AND d.day < ?
        AND json_type(d.metrics_json, '$.w."' || ? || '"') IS NOT NULL
      GROUP BY p.protocol
      HAVING SUM(COALESCE(CAST(json_extract(d.metrics_json, '$.p."' || p.protocol || '"[3]') AS INTEGER), 0)) > 0
    ), raw_metrics AS (
      SELECT q.protocol AS protocol, COUNT(*) AS attempts,
        SUM(CASE WHEN q.status = 'quoted' THEN 1 ELSE 0 END) AS successes
      FROM benchmark_runs r
      JOIN protocol_quotes q ON q.run_id = r.id
      WHERE r.pair_id = ? AND r.amount_id = ? AND r.mode = ?
        AND r.initiated_at >= ?
        AND r.oracle_captured_at IS NOT NULL
        AND r.completed_at IS NOT NULL AND r.status IN ('complete', 'partial')
        AND q.protocol IN (${protocolPlaceholders})
        AND (
          substr(r.initiated_at, 1, 10) = ?
          OR substr(r.initiated_at, 1, 10) = ?
          OR NOT EXISTS (
            SELECT 1 FROM daily_comparison_metrics d
            WHERE d.day = substr(r.initiated_at, 1, 10)
              AND d.mode = r.mode
              AND json_type(d.metrics_json, '$.w."' || ? || '"') IS NOT NULL
          )
        )
      GROUP BY q.protocol
    ), combined AS (
      SELECT * FROM aggregate_metrics
      UNION ALL
      SELECT * FROM raw_metrics
    )
    SELECT protocol, SUM(attempts) AS attempts, SUM(successes) AS successes
    FROM combined
    GROUP BY protocol
  `).bind(
    ...selectedProtocols,
    routeId, amountId, bestOutputMode, cutoffDay, today, protocolMask,
    routeId, amountId, bestOutputMode, startAt, ...selectedProtocols, cutoffDay, today, protocolMask,
  ).all<AvailabilityRow>();
  return new Map(result.results.map((row) => [row.protocol, {
    attempts: Number(row.attempts),
    successes: Number(row.successes),
  }]));
}

export async function GET(request: Request) {
  try {
    await ensureBenchmarkSchema();
    const url = new URL(request.url);
    const routeId = url.searchParams.get("routeId")?.trim();
    const amountId = url.searchParams.get("amountId")?.trim();
    const requestedDays = Number(url.searchParams.get("days") ?? 1);
    const days = [1, 7, 14, 30].includes(requestedDays) ? requestedDays : 1;
    const requestedProtocols = (url.searchParams.get("protocols") ?? "").split(",").filter((value): value is PartnerId => protocols.includes(value as PartnerId));
    const selectedProtocols = requestedProtocols.length >= 2 ? protocols.filter((protocol) => requestedProtocols.includes(protocol)) : protocols;
    if (!routeId || !amountId) return Response.json({ error: "routeId and amountId are required" }, { status: 400 });

    const requestedRunId = Number(url.searchParams.get("runId"));
    const revision = await resolveRunRevision(routeId, amountId, requestedRunId);
    if (url.searchParams.has("runId") && (!Number.isSafeInteger(requestedRunId) || requestedRunId <= 0 || !revision)) {
      return Response.json({ error: "A completed oracle-backed quote batch for this route and size is required" }, { status: 400 });
    }
    // Resolve the real batch before caching; arbitrary client revisions cannot
    // create cache entries. A newly completed route bypasses the previous batch.
    const cacheUrl = new URL(request.url);
    cacheUrl.searchParams.set("runId", String(revision?.runId ?? 0));
    const cacheRequest = new Request(cacheUrl.toString(), { headers: request.headers });
    const cached = await readPublicCache(cacheRequest);
    if (cached) return cached;

    const endAt = Date.now();
    const startAt = endAt - days * 24 * 60 * 60 * 1000;
    const bucketMs = days === 7 ? 60 * 60 * 1000 : 4 * 60 * 60 * 1000;
    const bucketSeconds = bucketMs / 1000;
    const firstBucketAt = Math.floor(startAt / bucketMs) * bucketMs;
    const bucketResult = await getD1().prepare(`
      SELECT bucket_start AS bucketStart, samples_json AS samplesJson
      FROM trend_buckets
      WHERE pair_id = ? AND amount_id = ? AND mode = ? AND bucket_seconds = ?
        AND bucket_start >= ? AND bucket_start <= ?
      ORDER BY bucket_start
    `).bind(
      routeId,
      amountId,
      bestOutputMode,
      bucketSeconds,
      new Date(firstBucketAt).toISOString(),
      new Date(endAt).toISOString(),
    ).all<TrendBucketRow>();

    const archivedRuns = bucketResult.results.flatMap((bucket) => parseStoredRuns(bucket.samplesJson))
      .filter((run) => !revision || (run.runId <= revision.runId && run.initiatedAt <= revision.initiatedAt));
    const recentRuns = revision ? await loadRecentRuns(routeId, amountId, revision, startAt, archivedRuns) : [];
    // Raw completed batches replace their archived copy, never add another vote.
    const storedRuns = [...new Map([...archivedRuns, ...recentRuns].map((run) => [run.runId, run])).values()];
    const rows = scoreRuns(storedRuns, selectedProtocols, startAt, endAt);
    const availabilityByProtocol = await loadAvailability(
      routeId,
      amountId,
      selectedProtocols,
      new Date(startAt).toISOString(),
    );
    const comparableRuns = new Set(rows.map((row) => row.runId)).size;
    const latestComparisonAt = rows.length ? new Date(Math.max(...rows.map((row) => row.timestamp))).toISOString() : null;
    const summary = selectedProtocols.map((protocol) => {
      const protocolRows = rows.filter((row) => row.protocol === protocol);
      const oracleGaps = protocolRows.map((row) => row.oracleGapBps);
      const availability = availabilityByProtocol.get(protocol);
      return {
        protocol,
        averageOracleGapBps: oracleGaps.length ? oracleGaps.reduce((sum, value) => sum + value, 0) / oracleGaps.length : null,
        medianOracleGapBps: median(oracleGaps),
        winRate: comparableRuns ? protocolRows.reduce((sum, row) => sum + row.winCredit, 0) / comparableRuns : null,
        sampleCount: protocolRows.length,
        attempts: availability?.attempts ?? 0,
        availability: availability?.attempts ? availability.successes / availability.attempts : 0,
      };
    });
    const leader = [...summary].filter((item) => item.sampleCount > 0 && item.winRate != null)
      .sort((a, b) => Number(b.winRate) - Number(a.winRate)
        || Number(b.averageOracleGapBps ?? -Infinity) - Number(a.averageOracleGapBps ?? -Infinity)
        || b.availability - a.availability)[0] ?? null;

    const pointMode = days <= 7 ? "comparison" : "bucket_median";
    const comparisonRuns = [...new Map(storedRuns
      .filter((run) => {
        const timestamp = new Date(run.initiatedAt).getTime();
        return Number.isFinite(timestamp) && timestamp >= startAt && timestamp <= endAt;
      })
      .map((run) => [run.runId, run] as const)).values()];
    const pointGroups = pointMode === "comparison"
      ? comparisonRuns
          .sort((a, b) => new Date(a.initiatedAt).getTime() - new Date(b.initiatedAt).getTime())
          .map((run) => ({
            timestamp: new Date(run.initiatedAt).getTime(),
            rows: rows.filter((row) => row.runId === run.runId),
          }))
      : Array.from({ length: Math.floor((endAt - firstBucketAt) / bucketMs) + 1 }, (_, index) => {
          const timestamp = firstBucketAt + index * bucketMs;
          return { timestamp, rows: rows.filter((row) => Math.floor(row.timestamp / bucketMs) * bucketMs === timestamp) };
        });
    const buckets = pointGroups.map(({ timestamp, rows: pointRows }) => {
      const points = selectedProtocols.map((protocol) => {
        const protocolRows = pointRows.filter((row) => row.protocol === protocol);
        const pointRuns = new Set(pointRows.map((row) => row.runId)).size;
        return {
          protocol,
          oracleGapBps: median(protocolRows.map((row) => row.oracleGapBps)),
          sampleCount: protocolRows.length,
          winRate: pointRuns ? protocolRows.reduce((sum, row) => sum + row.winCredit, 0) / pointRuns : null,
        };
      });
      return { timestamp, points };
    });

    return writePublicCache(cacheRequest, Response.json({
      routeId, amountId, protocols: selectedProtocols, days, baseline: "thorchain_cex_oracle",
      ranking: "overall_win_share",
      comparisonRule: "Every quote is measured against the synchronized THORChain CEX-derived oracle cross-rate. The best available quote wins each batch, including batches with one valid quote; exact ties split the win equally.",
      bucketMs, expectedIntervalMs: expectedCollectionIntervalMs, pointMode,
      startAt: new Date(startAt).toISOString(), endAt: new Date(endAt).toISOString(),
      latestRunId: revision?.runId ?? null, latestComparisonAt,
      comparableRuns, leader, summary, buckets,
    }, { headers: publicCacheHeaders(900) }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Trend data unavailable";
    if (message.includes("no such table")) {
      return Response.json({ error: "Trend data is initializing", buckets: [], summary: [], comparableRuns: 0 }, { status: 503 });
    }
    return Response.json({ error: message }, { status: 500 });
  }
}
