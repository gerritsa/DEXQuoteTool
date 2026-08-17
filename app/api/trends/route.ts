import { ensureBenchmarkSchema, getD1 } from "../../../db";

type PartnerId = "thorchain" | "chainflip" | "near-intents" | "maya";
type ScoredRow = { runId: number; initiatedAt: string; protocol: PartnerId; output: number; medianOutput: number; bestOutput: number; thorOutput: number | null };
const protocols: PartnerId[] = ["thorchain", "chainflip", "near-intents", "maya"];

function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export async function GET(request: Request) {
  try {
    await ensureBenchmarkSchema();
    const url = new URL(request.url);
    const routeId = url.searchParams.get("routeId")?.trim();
    const amountId = url.searchParams.get("amountId")?.trim();
    const requestedDays = Number(url.searchParams.get("days") ?? 7);
    const days = [7, 14, 30].includes(requestedDays) ? requestedDays : 7;
    if (!routeId || !amountId) return Response.json({ error: "routeId and amountId are required" }, { status: 400 });

    const endAt = Date.now();
    const startAt = endAt - days * 24 * 60 * 60 * 1000;
    const cutoff = new Date(startAt).toISOString();
    const bucketMs = days === 7 ? 60 * 60 * 1000 : 4 * 60 * 60 * 1000;
    const result = await getD1().prepare(`
      WITH valid AS (
        SELECT r.id AS run_id, r.initiated_at AS initiated_at, q.protocol AS protocol,
          CAST(q.expected_output_formatted AS REAL) AS output
        FROM benchmark_runs r
        JOIN protocol_quotes q ON q.run_id = r.id
        WHERE r.mode = 'standard' AND r.pair_id = ?1 AND r.range_id = ?2
          AND r.initiated_at >= ?3 AND q.status = 'quoted'
          AND CAST(q.expected_output_formatted AS REAL) > 0
      ), ranked AS (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY run_id ORDER BY output) AS output_rank,
          COUNT(*) OVER (PARTITION BY run_id) AS valid_count,
          MAX(output) OVER (PARTITION BY run_id) AS best_output,
          MAX(CASE WHEN protocol = 'thorchain' THEN output END) OVER (PARTITION BY run_id) AS thor_output
        FROM valid
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
        ranked.best_output AS bestOutput, ranked.thor_output AS thorOutput
      FROM ranked JOIN medians ON medians.run_id = ranked.run_id
      ORDER BY ranked.initiated_at, ranked.protocol
    `).bind(routeId, amountId, cutoff).all<ScoredRow>();

    const rows = result.results.map((row) => ({
      ...row,
      timestamp: new Date(row.initiatedAt).getTime(),
      edgeBps: ((Number(row.output) / Number(row.medianOutput)) - 1) * 10_000,
      vsThorBps: row.thorOutput && row.thorOutput > 0 ? ((Number(row.output) / Number(row.thorOutput)) - 1) * 10_000 : null,
      won: ((Number(row.bestOutput) - Number(row.output)) / Number(row.bestOutput)) * 10_000 <= 2,
    }));
    const comparableRuns = new Set(rows.map((row) => row.runId)).size;
    const summary = protocols.map((protocol) => {
      const protocolRows = rows.filter((row) => row.protocol === protocol);
      const edges = protocolRows.map((row) => row.edgeBps);
      return {
        protocol,
        averageEdgeBps: edges.length ? edges.reduce((sum, value) => sum + value, 0) / edges.length : null,
        medianEdgeBps: median(edges),
        winRate: protocolRows.length ? protocolRows.filter((row) => row.won).length / protocolRows.length : null,
        sampleCount: protocolRows.length,
        availability: comparableRuns ? protocolRows.length / comparableRuns : 0,
      };
    });
    const leader = [...summary].filter((item) => item.sampleCount > 0 && item.availability >= 0.8 && item.averageEdgeBps != null)
      .sort((a, b) => Number(b.averageEdgeBps) - Number(a.averageEdgeBps))[0] ?? null;

    const bucketStarts: number[] = [];
    for (let bucket = Math.floor(startAt / bucketMs) * bucketMs; bucket <= endAt; bucket += bucketMs) bucketStarts.push(bucket);
    const buckets = bucketStarts.map((timestamp) => {
      const bucketRows = rows.filter((row) => Math.floor(row.timestamp / bucketMs) * bucketMs === timestamp);
      const points = protocols.map((protocol) => {
        const protocolRows = bucketRows.filter((row) => row.protocol === protocol);
        return {
          protocol,
          edgeBps: median(protocolRows.map((row) => row.edgeBps)),
          vsThorBps: median(protocolRows.flatMap((row) => row.vsThorBps == null ? [] : [row.vsThorBps])),
          sampleCount: protocolRows.length,
          winRate: protocolRows.length ? protocolRows.filter((row) => row.won).length / protocolRows.length : null,
        };
      });
      const winner = [...points].filter((point) => point.edgeBps != null).sort((a, b) => Number(b.edgeBps) - Number(a.edgeBps))[0]?.protocol ?? null;
      return { timestamp, winner, points };
    });

    return Response.json({
      routeId, amountId, days, baseline: "batch_median",
      comparisonRule: "Every synchronized batch is compared with its median output; results within 2 bps of the best share the win.",
      minimumAvailability: 0.8, bucketMs,
      startAt: new Date(startAt).toISOString(), endAt: new Date(endAt).toISOString(),
      comparableRuns, leader, summary, buckets,
    }, { headers: { "cache-control": "private, max-age=60" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Trend data unavailable" }, { status: 500 });
  }
}
