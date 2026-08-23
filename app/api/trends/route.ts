import { ensureBenchmarkSchema, getD1 } from "../../../db";
import { publicCacheHeaders, readPublicCache, writePublicCache } from "../../../lib/http-cache";

type PartnerId = "thorchain" | "chainflip" | "near-intents" | "maya";
type ExecutionMode = "standard" | "optimized";
type ScoredRow = { runId: number; initiatedAt: string; protocol: PartnerId; output: number; medianOutput: number; bestOutput: number; winnerCount: number };
const protocols: PartnerId[] = ["near-intents", "chainflip", "thorchain", "maya"];

function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
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
    const cutoff = new Date(startAt).toISOString();
    const bucketMs = days === 7 ? 60 * 60 * 1000 : 4 * 60 * 60 * 1000;
    const protocolPlaceholders = selectedProtocols.map(() => "?").join(", ");
    const result = await getD1().prepare(`
      WITH valid AS (
        SELECT r.id AS run_id, r.initiated_at AS initiated_at, q.protocol AS protocol,
          CAST(q.expected_output_formatted AS REAL) AS output
        FROM benchmark_runs r
        JOIN protocol_quotes q ON q.run_id = r.id
        WHERE r.mode = ? AND r.pair_id = ? AND r.amount_id = ?
          AND r.initiated_at >= ? AND q.protocol IN (${protocolPlaceholders}) AND q.status = 'quoted'
          AND CAST(q.expected_output_formatted AS REAL) > 0
      ), ranked AS (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY run_id ORDER BY output) AS output_rank,
          COUNT(*) OVER (PARTITION BY run_id) AS valid_count,
          MAX(output) OVER (PARTITION BY run_id) AS best_output
        FROM valid
      ), run_stats AS (
        SELECT run_id, MAX(best_output) AS best_output,
          SUM(CASE WHEN output = best_output THEN 1 ELSE 0 END) AS winner_count
        FROM ranked
        WHERE valid_count >= 2
        GROUP BY run_id
      ), medians AS (
        SELECT run_id, AVG(output) AS median_output
        FROM ranked
        WHERE valid_count >= 2 AND (
          output_rank = CAST((valid_count + 1) / 2 AS INTEGER)
          OR output_rank = CAST((valid_count + 2) / 2 AS INTEGER)
        )
        GROUP BY run_id
      )
      SELECT ranked.run_id AS runId, ranked.initiated_at AS initiatedAt, ranked.protocol AS protocol,
        ranked.output AS output, medians.median_output AS medianOutput,
        run_stats.best_output AS bestOutput, run_stats.winner_count AS winnerCount
      FROM ranked
      JOIN medians ON medians.run_id = ranked.run_id
      JOIN run_stats ON run_stats.run_id = ranked.run_id
      ORDER BY ranked.initiated_at, ranked.protocol
    `).bind(mode, routeId, amountId, cutoff, ...selectedProtocols).all<ScoredRow>();

    const rows = result.results.map((row) => ({
      ...row,
      timestamp: new Date(row.initiatedAt).getTime(),
      edgeBps: ((Number(row.output) / Number(row.medianOutput)) - 1) * 10_000,
      winCredit: Number(row.output) === Number(row.bestOutput) ? 1 / Number(row.winnerCount) : 0,
    }));
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
    for (let bucket = Math.floor(startAt / bucketMs) * bucketMs; bucket <= endAt; bucket += bucketMs) bucketStarts.push(bucket);
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
    }, { headers: publicCacheHeaders(300) }));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Trend data unavailable" }, { status: 500 });
  }
}
