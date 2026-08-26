import { ensureBenchmarkSchema, getD1 } from "../../../db";
import { publicCacheHeaders, readPublicCache, writePublicCache } from "../../../lib/http-cache";

type PartnerId = "thorchain" | "chainflip" | "near-intents" | "maya";
type ExecutionMode = "standard" | "optimized";
type TrendBucketRow = { bucketStart: string; samplesJson: string };
type AvailabilityRow = { protocol: PartnerId; attempts: number; successes: number };
type StoredQuote = { protocol: PartnerId; output: number };
type StoredRun = { runId: number; initiatedAt: string; quotes: StoredQuote[] };
type ScoredRow = {
  runId: number;
  initiatedAt: string;
  timestamp: number;
  protocol: PartnerId;
  edgeBps: number;
  winCredit: number;
};

const protocols: PartnerId[] = ["near-intents", "chainflip", "thorchain"];
const metricProtocolOrder: PartnerId[] = ["thorchain", "chainflip", "near-intents"];

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
        if (!storedQuote.protocol || !protocols.includes(storedQuote.protocol) || !Number.isFinite(Number(storedQuote.output))) return [];
        return [{ protocol: storedQuote.protocol, output: Number(storedQuote.output) }];
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
    if (quotes.length < 2) continue;
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
        edgeBps: ((output / bestOutput) - 1) * 10_000,
        winCredit: output === bestOutput ? 1 / winnerCount : 0,
      });
    }
  }
  return rows;
}

async function loadAvailability(
  routeId: string,
  amountId: string,
  mode: ExecutionMode,
  selectedProtocols: PartnerId[],
  startAt: string,
) {
  const cutoffDay = startAt.slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  const protocolMask = metricProtocolOrder.filter((protocol) => selectedProtocols.includes(protocol)).join(",");
  const protocolPlaceholders = selectedProtocols.map(() => "?").join(", ");
  const result = await getD1().prepare(`
    WITH aggregate_metrics AS (
      SELECT protocol, SUM(attempts) AS attempts, SUM(successes) AS successes
      FROM daily_comparison_metrics
      WHERE pair_id = ? AND amount_id = ? AND mode = ?
        AND day > ? AND day < ? AND protocol_mask = ?
        AND protocol IN (${protocolPlaceholders})
      GROUP BY protocol
    ), raw_metrics AS (
      SELECT q.protocol AS protocol, COUNT(*) AS attempts,
        SUM(CASE WHEN q.status = 'quoted' THEN 1 ELSE 0 END) AS successes
      FROM benchmark_runs r
      JOIN protocol_quotes q ON q.run_id = r.id
      WHERE r.pair_id = ? AND r.amount_id = ? AND r.mode = ?
        AND r.initiated_at >= ?
        AND r.completed_at IS NOT NULL AND r.status IN ('complete', 'partial')
        AND q.protocol IN (${protocolPlaceholders})
        AND (
          substr(r.initiated_at, 1, 10) = ?
          OR substr(r.initiated_at, 1, 10) = ?
          OR NOT EXISTS (
            SELECT 1 FROM daily_comparison_metrics d
            WHERE d.day = substr(r.initiated_at, 1, 10)
              AND d.mode = r.mode AND d.protocol_mask = ?
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
    routeId, amountId, mode, cutoffDay, today, protocolMask, ...selectedProtocols,
    routeId, amountId, mode, startAt, ...selectedProtocols, cutoffDay, today, protocolMask,
  ).all<AvailabilityRow>();
  return new Map(result.results.map((row) => [row.protocol, {
    attempts: Number(row.attempts),
    successes: Number(row.successes),
  }]));
}

export async function GET(request: Request) {
  try {
    const cached = await readPublicCache(request);
    if (cached) return cached;
    await ensureBenchmarkSchema();
    const url = new URL(request.url);
    const routeId = url.searchParams.get("routeId")?.trim();
    const amountId = url.searchParams.get("amountId")?.trim();
    const requestedDays = Number(url.searchParams.get("days") ?? 7);
    const days = [7, 14, 30].includes(requestedDays) ? requestedDays : 7;
    const mode: ExecutionMode = url.searchParams.get("mode") === "optimized" ? "optimized" : "standard";
    const requestedProtocols = (url.searchParams.get("protocols") ?? "").split(",").filter((value): value is PartnerId => protocols.includes(value as PartnerId));
    const selectedProtocols = requestedProtocols.length >= 2 ? protocols.filter((protocol) => requestedProtocols.includes(protocol)) : protocols;
    if (!routeId || !amountId) return Response.json({ error: "routeId and amountId are required" }, { status: 400 });

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
      mode,
      bucketSeconds,
      new Date(firstBucketAt).toISOString(),
      new Date(endAt).toISOString(),
    ).all<TrendBucketRow>();

    const storedRuns = bucketResult.results.flatMap((bucket) => parseStoredRuns(bucket.samplesJson));
    const rows = scoreRuns(storedRuns, selectedProtocols, startAt, endAt);
    const availabilityByProtocol = await loadAvailability(
      routeId,
      amountId,
      mode,
      selectedProtocols,
      new Date(startAt).toISOString(),
    );
    const comparableRuns = new Set(rows.map((row) => row.runId)).size;
    const summary = selectedProtocols.map((protocol) => {
      const protocolRows = rows.filter((row) => row.protocol === protocol);
      const edges = protocolRows.map((row) => row.edgeBps);
      const availability = availabilityByProtocol.get(protocol);
      return {
        protocol,
        averageEdgeBps: edges.length ? edges.reduce((sum, value) => sum + value, 0) / edges.length : null,
        medianEdgeBps: median(edges),
        winRate: comparableRuns ? protocolRows.reduce((sum, row) => sum + row.winCredit, 0) / comparableRuns : null,
        sampleCount: protocolRows.length,
        availability: availability?.attempts ? availability.successes / availability.attempts : 0,
      };
    });
    const leader = [...summary].filter((item) => item.sampleCount > 0 && item.winRate != null)
      .sort((a, b) => Number(b.winRate) - Number(a.winRate)
        || Number(b.averageEdgeBps ?? -Infinity) - Number(a.averageEdgeBps ?? -Infinity)
        || b.availability - a.availability)[0] ?? null;

    const bucketStarts: number[] = [];
    for (let bucket = firstBucketAt; bucket <= endAt; bucket += bucketMs) bucketStarts.push(bucket);
    const buckets = bucketStarts.map((timestamp) => {
      const bucketRows = rows.filter((row) => Math.floor(row.timestamp / bucketMs) * bucketMs === timestamp);
      const points = selectedProtocols.map((protocol) => {
        const protocolRows = bucketRows.filter((row) => row.protocol === protocol);
        const bucketRuns = new Set(bucketRows.map((row) => row.runId)).size;
        return {
          protocol,
          edgeBps: median(protocolRows.map((row) => row.edgeBps)),
          sampleCount: protocolRows.length,
          winRate: bucketRuns ? protocolRows.reduce((sum, row) => sum + row.winCredit, 0) / bucketRuns : null,
        };
      });
      return { timestamp, points };
    });

    return writePublicCache(request, Response.json({
      routeId, amountId, mode, protocols: selectedProtocols, days, baseline: "batch_best",
      ranking: "overall_win_share",
      comparisonRule: "The period leader has the highest share of comparable batch wins. Unavailable quotes cannot win, and exact ties split the win equally.",
      bucketMs,
      startAt: new Date(startAt).toISOString(), endAt: new Date(endAt).toISOString(),
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
