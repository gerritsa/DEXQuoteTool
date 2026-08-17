import { ensureBenchmarkSchema, getD1 } from "../../../db";

type WindowName = "now" | "7d" | "14d" | "30d";
type ExecutionMode = "standard" | "optimized";
type PartnerId = "thorchain" | "chainflip" | "near-intents" | "maya";
const protocols: PartnerId[] = ["near-intents", "chainflip", "thorchain", "maya"];
type NowRow = { pairId: string; amountId: string; initiatedAt: string; protocol: string; status: string; output: number | null };
type HistoryRow = { pairId: string; amountId: string; protocol: string; attempts: number; successes: number; comparableSamples: number; averageEdgeBps: number | null; wins: number; latestAt: string };

function groupByCell<T extends { pairId: string; amountId: string }>(rows: T[]) {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const key = `${row.pairId}::${row.amountId}`;
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }
  return grouped;
}

async function latestComparison(mode: ExecutionMode, selectedProtocols: PartnerId[]) {
  const protocolPlaceholders = selectedProtocols.map(() => "?").join(", ");
  const result = await getD1().prepare(`
    WITH latest AS (
      SELECT pair_id, range_id, MAX(id) AS run_id
      FROM benchmark_runs
      WHERE mode = ?
      GROUP BY pair_id, range_id
    )
    SELECT r.pair_id AS pairId, r.range_id AS amountId, r.initiated_at AS initiatedAt,
      q.protocol AS protocol, q.status AS status, CAST(q.expected_output_formatted AS REAL) AS output
    FROM latest l
    JOIN benchmark_runs r ON r.id = l.run_id
    JOIN protocol_quotes q ON q.run_id = r.id
    WHERE q.protocol IN (${protocolPlaceholders})
    ORDER BY r.pair_id, r.range_id, q.protocol
  `).bind(mode, ...selectedProtocols).all<NowRow>();

  const cells = [...groupByCell(result.results).values()].map((rows) => {
    const quoted = rows.filter((row) => row.status === "quoted" && row.output != null && row.output > 0)
      .sort((a, b) => Number(b.output) - Number(a.output));
    const winner = quoted[0];
    const runnerUp = quoted[1];
    const marginBps = winner && runnerUp ? ((Number(winner.output) / Number(runnerUp.output)) - 1) * 10_000 : null;
    return {
      pairId: rows[0].pairId,
      amountId: rows[0].amountId,
      capturedAt: rows[0].initiatedAt,
      leader: quoted.length >= 2 ? winner.protocol : null,
      marginBps,
      tie: marginBps != null && marginBps <= 2,
      successfulQuotes: quoted.length,
      results: rows.map((row) => ({ protocol: row.protocol, status: row.status, output: row.output })),
    };
  });
  return { window: "now" as const, mode, cells };
}

async function periodComparison(window: Exclude<WindowName, "now">, mode: ExecutionMode, selectedProtocols: PartnerId[]) {
  const days = Number(window.slice(0, -1));
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const protocolPlaceholders = selectedProtocols.map(() => "?").join(", ");
  const result = await getD1().prepare(`
    WITH attempts AS (
      SELECT r.id AS run_id, r.pair_id AS pair_id, r.range_id AS amount_id,
        r.initiated_at AS initiated_at, q.protocol AS protocol, q.status AS status,
        CAST(q.expected_output_formatted AS REAL) AS output
      FROM benchmark_runs r
      JOIN protocol_quotes q ON q.run_id = r.id
      WHERE r.mode = ? AND r.initiated_at >= ? AND q.protocol IN (${protocolPlaceholders})
    ), valid AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY run_id ORDER BY output) AS output_rank,
        COUNT(*) OVER (PARTITION BY run_id) AS valid_count,
        MAX(output) OVER (PARTITION BY run_id) AS best_output
      FROM attempts
      WHERE status = 'quoted' AND output > 0
    ), medians AS (
      SELECT run_id, AVG(output) AS median_output, MAX(valid_count) AS valid_count, MAX(best_output) AS best_output
      FROM valid
      WHERE output_rank = CAST((valid_count + 1) / 2 AS INTEGER)
         OR output_rank = CAST((valid_count + 2) / 2 AS INTEGER)
      GROUP BY run_id
    ), scored AS (
      SELECT attempts.*, medians.median_output, medians.valid_count, medians.best_output
      FROM attempts LEFT JOIN medians ON medians.run_id = attempts.run_id
    )
    SELECT pair_id AS pairId, amount_id AS amountId, protocol AS protocol,
      COUNT(*) AS attempts,
      SUM(CASE WHEN status = 'quoted' THEN 1 ELSE 0 END) AS successes,
      SUM(CASE WHEN status = 'quoted' AND valid_count >= 2 THEN 1 ELSE 0 END) AS comparableSamples,
      AVG(CASE WHEN status = 'quoted' AND valid_count >= 2 THEN ((output / median_output) - 1) * 10000 END) AS averageEdgeBps,
      SUM(CASE WHEN status = 'quoted' AND valid_count >= 2 AND ((best_output - output) / best_output) * 10000 <= 2 THEN 1 ELSE 0 END) AS wins,
      MAX(initiated_at) AS latestAt
    FROM scored
    GROUP BY pair_id, amount_id, protocol
    ORDER BY pair_id, amount_id, protocol
  `).bind(mode, cutoff, ...selectedProtocols).all<HistoryRow>();

  const cells = [...groupByCell(result.results).values()].map((rows) => {
    const measured = rows.map((row) => ({ ...row, availability: row.attempts ? row.successes / row.attempts : 0 }));
    const eligible = measured.filter((row) => row.comparableSamples > 0 && row.averageEdgeBps != null && row.availability >= 0.8)
      .sort((a, b) => Number(b.averageEdgeBps) - Number(a.averageEdgeBps));
    const leader = eligible[0];
    return {
      pairId: rows[0].pairId,
      amountId: rows[0].amountId,
      capturedAt: rows.reduce((latest, row) => row.latestAt > latest ? row.latestAt : latest, rows[0].latestAt),
      leader: leader?.protocol ?? null,
      averageEdgeBps: leader?.averageEdgeBps ?? null,
      winRate: leader ? leader.wins / leader.comparableSamples : null,
      sampleCount: leader?.comparableSamples ?? Math.max(...rows.map((row) => row.comparableSamples)),
      availability: leader?.availability ?? null,
      coverageQualified: Boolean(leader),
      results: measured.map((row) => ({ protocol: row.protocol, averageEdgeBps: row.averageEdgeBps, wins: row.wins, samples: row.comparableSamples, availability: row.availability })),
    };
  });
  return { window, mode, cutoff, baseline: "batch_median", minimumAvailability: 0.8, cells };
}

export async function GET(request: Request) {
  try {
    await ensureBenchmarkSchema();
    const url = new URL(request.url);
    const requested = url.searchParams.get("window") as WindowName | null;
    const window: WindowName = requested && ["now", "7d", "14d", "30d"].includes(requested) ? requested : "now";
    const mode: ExecutionMode = url.searchParams.get("mode") === "optimized" ? "optimized" : "standard";
    const requestedProtocols = (url.searchParams.get("protocols") ?? "").split(",").filter((value): value is PartnerId => protocols.includes(value as PartnerId));
    const selectedProtocols = requestedProtocols.length >= 2 ? protocols.filter((protocol) => requestedProtocols.includes(protocol)) : protocols;
    const payload = window === "now" ? await latestComparison(mode, selectedProtocols) : await periodComparison(window, mode, selectedProtocols);
    return Response.json(payload, { headers: { "cache-control": "private, max-age=15" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Comparison data unavailable";
    if (message.includes("no such table") || message.includes("no such column")) return Response.json({ window: "now", cells: [], migrationPending: true });
    return Response.json({ error: message }, { status: 500 });
  }
}
