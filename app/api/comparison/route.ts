import { ensureBenchmarkSchema, getD1 } from "../../../db";
import { publicCacheHeaders, readPublicCache, writePublicCache } from "../../../lib/http-cache";
import { bestOutputMode } from "../../../lib/quotes/protocols";

type WindowName = "now" | "7d" | "14d" | "30d";
type PartnerId = "thorchain" | "chainflip" | "near-intents" | "maya";
const protocols: PartnerId[] = ["near-intents", "chainflip", "thorchain", "maya"];
const metricProtocolOrder: PartnerId[] = ["thorchain", "chainflip", "near-intents", "maya"];
type NowRow = { pairId: string; amountId: string; initiatedAt: string; protocol: string; status: string; output: number | null; oracleGapBps: number | null };
type HistoryRow = { pairId: string; amountId: string; protocol: string; attempts: number; successes: number; comparableSamples: number; oracleSamples: number; oracleGapSumBps: number; wins: number; latestAt: string };

function groupByCell<T extends { pairId: string; amountId: string }>(rows: T[]) {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const key = `${row.pairId}::${row.amountId}`;
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }
  return grouped;
}

async function latestComparison(selectedProtocols: PartnerId[]) {
  const protocolPlaceholders = selectedProtocols.map(() => "?").join(", ");
  // This table is already updated atomically when a run completes and stays
  // bounded to one row per route, amount, stored strategy mode, and protocol.
  const result = await getD1().prepare(`
    WITH latest AS (
      SELECT pair_id, amount_id, MAX(run_id) AS run_id
      FROM latest_quote_payloads
      WHERE mode = ?
      GROUP BY pair_id, amount_id
    )
    SELECT r.pair_id AS pairId, r.amount_id AS amountId, r.initiated_at AS initiatedAt,
      q.protocol AS protocol, q.status AS status, CAST(q.expected_output_formatted AS REAL) AS output,
      q.oracle_gap_bps AS oracleGapBps
    FROM latest l
    JOIN benchmark_runs r ON r.id = l.run_id
    JOIN protocol_quotes q ON q.run_id = r.id
    WHERE r.oracle_captured_at IS NOT NULL
      AND r.completed_at IS NOT NULL AND r.status IN ('complete', 'partial')
      AND q.protocol IN (${protocolPlaceholders})
    ORDER BY r.pair_id, r.amount_id, q.protocol
  `).bind(bestOutputMode, ...selectedProtocols).all<NowRow>();

  const cells = [...groupByCell(result.results).values()].map((rows) => {
    const quoted = rows.filter((row) => row.status === "quoted" && row.output != null && row.output > 0)
      .sort((a, b) => Number(b.output) - Number(a.output));
    const winner = quoted[0];
    const runnerUp = quoted[1];
    const marginBps = winner && runnerUp ? ((Number(winner.output) / Number(runnerUp.output)) - 1) * 10_000 : null;
    const exactTie = Boolean(winner && runnerUp && Number(winner.output) === Number(runnerUp.output));
    return {
      pairId: rows[0].pairId,
      amountId: rows[0].amountId,
      capturedAt: rows[0].initiatedAt,
      leader: quoted.length >= 1 ? winner.protocol : null,
      runnerUp: quoted.length >= 2 ? runnerUp.protocol : null,
      marginBps,
      tie: exactTie,
      oracleGapBps: winner?.oracleGapBps ?? null,
      successfulQuotes: quoted.length,
      results: rows.map((row) => ({ protocol: row.protocol, status: row.status, output: row.output, oracleGapBps: row.oracleGapBps })),
    };
  });
  return { window: "now" as const, cells };
}

async function periodComparison(window: Exclude<WindowName, "now">, selectedProtocols: PartnerId[]) {
  const days = Number(window.slice(0, -1));
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const cutoffDay = cutoff.slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  const protocolMask = metricProtocolOrder.filter((protocol) => selectedProtocols.includes(protocol)).join(",");
  const protocolPlaceholders = selectedProtocols.map(() => "?").join(", ");
  const selectedProtocolRows = selectedProtocols.map(() => "SELECT ? AS protocol").join(" UNION ALL ");
  const result = await getD1().prepare(`
    WITH selected_protocols AS (
      ${selectedProtocolRows}
    ), aggregate_metrics AS (
      SELECT d.pair_id, d.amount_id, p.protocol,
        SUM(COALESCE(CAST(json_extract(d.metrics_json, '$.p."' || p.protocol || '"[0]') AS INTEGER), 0)) AS attempts,
        SUM(COALESCE(CAST(json_extract(d.metrics_json, '$.p."' || p.protocol || '"[1]') AS INTEGER), 0)) AS successes,
        SUM(COALESCE(CAST(json_extract(d.metrics_json, '$.p."' || p.protocol || '"[2]') AS INTEGER), 0)) AS comparable_samples,
        SUM(COALESCE(CAST(json_extract(d.metrics_json, '$.p."' || p.protocol || '"[3]') AS INTEGER), 0)) AS oracle_samples,
        SUM(COALESCE(CAST(json_extract(d.metrics_json, '$.p."' || p.protocol || '"[4]') AS REAL), 0)) AS oracle_gap_sum_bps,
        SUM(COALESCE(CAST(json_extract(d.metrics_json, '$.w."' || ? || '"."' || p.protocol || '"') AS REAL), 0)) AS wins,
        MAX(d.latest_at) AS latest_at
      FROM daily_comparison_metrics d
      CROSS JOIN selected_protocols p
      WHERE d.mode = ? AND d.day > ? AND d.day < ?
        AND json_type(d.metrics_json, '$.w."' || ? || '"') IS NOT NULL
      GROUP BY d.pair_id, d.amount_id, p.protocol
      HAVING SUM(COALESCE(CAST(json_extract(d.metrics_json, '$.p."' || p.protocol || '"[3]') AS INTEGER), 0)) > 0
    ), raw_attempts AS (
      SELECT r.id AS run_id, r.pair_id AS pair_id, r.amount_id AS amount_id,
        r.initiated_at AS initiated_at, q.protocol AS protocol, q.status AS status,
        CAST(q.expected_output_formatted AS REAL) AS output, q.oracle_gap_bps AS oracle_gap_bps
      FROM benchmark_runs r
      JOIN protocol_quotes q ON q.run_id = r.id
      WHERE r.mode = ? AND r.initiated_at >= ?
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
    ), valid AS (
      SELECT *, COUNT(*) OVER (PARTITION BY run_id) AS valid_count,
        MAX(output) OVER (PARTITION BY run_id) AS best_output
      FROM raw_attempts
      WHERE status = 'quoted' AND output > 0
    ), run_stats AS (
      SELECT run_id, MAX(valid_count) AS valid_count, MAX(best_output) AS best_output,
        SUM(CASE WHEN output = best_output THEN 1 ELSE 0 END) AS winner_count
      FROM valid
      GROUP BY run_id
    ), scored AS (
      SELECT raw_attempts.*, run_stats.valid_count, run_stats.best_output, run_stats.winner_count
      FROM raw_attempts
      LEFT JOIN run_stats ON run_stats.run_id = raw_attempts.run_id
    ), raw_metrics AS (
      SELECT pair_id, amount_id, protocol,
        COUNT(*) AS attempts,
        SUM(CASE WHEN status = 'quoted' THEN 1 ELSE 0 END) AS successes,
        SUM(CASE WHEN status = 'quoted' AND valid_count >= 1 THEN 1 ELSE 0 END) AS comparable_samples,
        SUM(CASE WHEN status = 'quoted' AND oracle_gap_bps IS NOT NULL THEN 1 ELSE 0 END) AS oracle_samples,
        SUM(CASE WHEN status = 'quoted' AND oracle_gap_bps IS NOT NULL THEN oracle_gap_bps ELSE 0 END) AS oracle_gap_sum_bps,
        SUM(CASE WHEN status = 'quoted' AND valid_count >= 1 AND output = best_output THEN 1.0 / winner_count ELSE 0 END) AS wins,
        MAX(initiated_at) AS latest_at
      FROM scored
      GROUP BY pair_id, amount_id, protocol
    ), combined AS (
      SELECT * FROM aggregate_metrics
      UNION ALL
      SELECT * FROM raw_metrics
    )
    SELECT pair_id AS pairId, amount_id AS amountId, protocol AS protocol,
      SUM(attempts) AS attempts,
      SUM(successes) AS successes,
      SUM(comparable_samples) AS comparableSamples,
      SUM(oracle_samples) AS oracleSamples,
      SUM(oracle_gap_sum_bps) AS oracleGapSumBps,
      SUM(wins) AS wins,
      MAX(latest_at) AS latestAt
    FROM combined
    GROUP BY pair_id, amount_id, protocol
    ORDER BY pair_id, amount_id, protocol
  `).bind(
    ...selectedProtocols, protocolMask, bestOutputMode, cutoffDay, today, protocolMask,
    bestOutputMode, cutoff, ...selectedProtocols, cutoffDay, today, protocolMask,
  ).all<HistoryRow>();

  const cells = [...groupByCell(result.results).values()].map((rows) => {
    const comparableChecks = rows.reduce((sum, row) => sum + Number(row.wins), 0);
    const measured = rows.map((row) => ({
      ...row,
      availability: row.attempts ? row.successes / row.attempts : 0,
      averageOracleGapBps: row.oracleSamples ? row.oracleGapSumBps / row.oracleSamples : null,
      winRate: comparableChecks ? row.wins / comparableChecks : null,
    }));
    const ranked = measured.filter((row) => row.comparableSamples > 0 && row.winRate != null)
      .sort((a, b) => Number(b.winRate) - Number(a.winRate)
        || Number(b.averageOracleGapBps ?? -Infinity) - Number(a.averageOracleGapBps ?? -Infinity)
        || b.availability - a.availability);
    const leader = ranked[0];
    return {
      pairId: rows[0].pairId,
      amountId: rows[0].amountId,
      capturedAt: rows.reduce((latest, row) => row.latestAt > latest ? row.latestAt : latest, rows[0].latestAt),
      leader: leader?.protocol ?? null,
      averageOracleGapBps: leader?.averageOracleGapBps ?? null,
      winRate: leader?.winRate ?? null,
      sampleCount: comparableChecks,
      availability: leader?.availability ?? null,
      results: measured.map((row) => ({ protocol: row.protocol, averageOracleGapBps: row.averageOracleGapBps, wins: row.wins, winRate: row.winRate, samples: row.oracleSamples, comparisons: comparableChecks, availability: row.availability })),
    };
  });
  return { window, cutoff, baseline: "thorchain_cex_oracle", ranking: "overall_win_share", cells };
}

export async function GET(request: Request) {
  try {
    const cached = await readPublicCache(request);
    if (cached) return cached;
    await ensureBenchmarkSchema();
    const url = new URL(request.url);
    const requested = url.searchParams.get("window") as WindowName | null;
    const window: WindowName = requested && ["now", "7d", "14d", "30d"].includes(requested) ? requested : "now";
    const requestedProtocols = (url.searchParams.get("protocols") ?? "").split(",").filter((value): value is PartnerId => protocols.includes(value as PartnerId));
    const selectedProtocols = requestedProtocols.length >= 2 ? protocols.filter((protocol) => requestedProtocols.includes(protocol)) : protocols;
    const payload = window === "now" ? await latestComparison(selectedProtocols) : await periodComparison(window, selectedProtocols);
    return writePublicCache(request, Response.json(payload, { headers: publicCacheHeaders(900) }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Comparison data unavailable";
    if (message.includes("no such table") || message.includes("no such column")) return Response.json({ window: "now", cells: [], migrationPending: true });
    return Response.json({ error: message }, { status: 500 });
  }
}
