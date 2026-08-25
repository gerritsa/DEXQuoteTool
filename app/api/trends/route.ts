import { ensureBenchmarkSchema, getD1 } from "../../../db";
import { publicCacheHeaders, readPublicCache, writePublicCache } from "../../../lib/http-cache";

type PartnerId = "thorchain" | "chainflip" | "near-intents" | "maya";
type ExecutionMode = "standard" | "optimized";
type TrendBucketRow = { bucketStart: string; samplesJson: string };
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
    const medianOutput = median(quotes.map((quote) => Number(quote.output)));
    if (!medianOutput) continue;
    const bestOutput = Math.max(...quotes.map((quote) => Number(quote.output)));
    const winnerCount = quotes.filter((quote) => Number(quote.output) === bestOutput).length;
    for (const quote of quotes) {
      const output = Number(quote.output);
      rows.push({
        runId: run.runId,
        initiatedAt: run.initiatedAt,
        timestamp,
        protocol: quote.protocol,
        edgeBps: ((output / medianOutput) - 1) * 10_000,
        winCredit: output === bestOutput ? 1 / winnerCount : 0,
      });
    }
  }
  return rows;
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
    const comparableRuns = new Set(rows.map((row) => row.runId)).size;
    const summary = selectedProtocols.map((protocol) => {
      const protocolRows = rows.filter((row) => row.protocol === protocol);
      const edges = protocolRows.map((row) => row.edgeBps);
      return {
        protocol,
        averageEdgeBps: edges.length ? edges.reduce((sum, value) => sum + value, 0) / edges.length : null,
        medianEdgeBps: median(edges),
        winRate: comparableRuns ? protocolRows.reduce((sum, row) => sum + row.winCredit, 0) / comparableRuns : null,
        sampleCount: protocolRows.length,
        availability: comparableRuns ? protocolRows.length / comparableRuns : 0,
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
      routeId, amountId, mode, protocols: selectedProtocols, days, baseline: "batch_median",
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
