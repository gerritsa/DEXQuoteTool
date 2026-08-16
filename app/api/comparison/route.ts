import { ensureBenchmarkSchema, getD1 } from "../../../db";

type WindowName = "now" | "7d";

type NowRow = {
  pairId: string;
  amountId: string;
  initiatedAt: string;
  protocol: string;
  status: string;
  output: number | null;
};

type HistoryRow = {
  pairId: string;
  amountId: string;
  protocol: string;
  attempts: number;
  successes: number;
  comparableSamples: number;
  averageScore: number | null;
  wins: number;
  latestAt: string;
};

function groupByCell<T extends { pairId: string; amountId: string }>(rows: T[]) {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const key = `${row.pairId}::${row.amountId}`;
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }
  return grouped;
}

async function latestComparison() {
  const result = await getD1().prepare(`
    WITH latest AS (
      SELECT pair_id, range_id, MAX(id) AS run_id
      FROM benchmark_runs
      WHERE mode = 'standard'
      GROUP BY pair_id, range_id
    )
    SELECT
      r.pair_id AS pairId,
      r.range_id AS amountId,
      r.initiated_at AS initiatedAt,
      q.protocol AS protocol,
      q.status AS status,
      CAST(q.expected_output_formatted AS REAL) AS output
    FROM latest l
    JOIN benchmark_runs r ON r.id = l.run_id
    JOIN protocol_quotes q ON q.run_id = r.id
    ORDER BY r.pair_id, r.range_id, q.protocol
  `).all<NowRow>();

  const cells = [...groupByCell(result.results).values()].map((rows) => {
    const quoted = rows
      .filter((row) => row.status === "quoted" && row.output != null && row.output > 0)
      .sort((a, b) => Number(b.output) - Number(a.output));
    const winner = quoted[0];
    const runnerUp = quoted[1];
    const marginPct = winner && runnerUp
      ? ((Number(winner.output) / Number(runnerUp.output)) - 1) * 100
      : null;
    return {
      pairId: rows[0].pairId,
      amountId: rows[0].amountId,
      capturedAt: rows[0].initiatedAt,
      leader: quoted.length >= 2 ? winner.protocol : null,
      marginPct,
      tie: marginPct != null && marginPct <= 0.02,
      successfulQuotes: quoted.length,
      results: rows.map((row) => ({ protocol: row.protocol, status: row.status, output: row.output })),
    };
  });

  return { window: "now" as const, cells };
}

async function sevenDayComparison() {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const result = await getD1().prepare(`
    WITH attempts AS (
      SELECT
        r.id AS run_id,
        r.pair_id AS pair_id,
        r.range_id AS amount_id,
        r.initiated_at AS initiated_at,
        q.protocol AS protocol,
        q.status AS status,
        CAST(q.expected_output_formatted AS REAL) AS output
      FROM benchmark_runs r
      JOIN protocol_quotes q ON q.run_id = r.id
      WHERE r.mode = 'standard' AND r.initiated_at >= ?1
    ), scored AS (
      SELECT
        *,
        MAX(CASE WHEN status = 'quoted' THEN output END) OVER (PARTITION BY run_id) AS best_output,
        SUM(CASE WHEN status = 'quoted' AND output > 0 THEN 1 ELSE 0 END) OVER (PARTITION BY run_id) AS valid_count
      FROM attempts
    )
    SELECT
      pair_id AS pairId,
      amount_id AS amountId,
      protocol AS protocol,
      COUNT(*) AS attempts,
      SUM(CASE WHEN status = 'quoted' THEN 1 ELSE 0 END) AS successes,
      SUM(CASE WHEN status = 'quoted' AND valid_count >= 2 THEN 1 ELSE 0 END) AS comparableSamples,
      AVG(CASE WHEN status = 'quoted' AND valid_count >= 2 THEN (output / best_output) * 100 END) AS averageScore,
      SUM(CASE WHEN status = 'quoted' AND valid_count >= 2 AND ((best_output - output) / best_output) <= 0.0002 THEN 1 ELSE 0 END) AS wins,
      MAX(initiated_at) AS latestAt
    FROM scored
    GROUP BY pair_id, amount_id, protocol
    ORDER BY pair_id, amount_id, protocol
  `).bind(cutoff).all<HistoryRow>();

  const cells = [...groupByCell(result.results).values()].map((rows) => {
    const eligible = rows
      .filter((row) => row.comparableSamples > 0 && row.averageScore != null)
      .sort((a, b) => Number(b.averageScore) - Number(a.averageScore));
    const leader = eligible[0];
    return {
      pairId: rows[0].pairId,
      amountId: rows[0].amountId,
      capturedAt: rows.reduce((latest, row) => row.latestAt > latest ? row.latestAt : latest, rows[0].latestAt),
      leader: leader?.protocol ?? null,
      averageShortfallBps: leader?.averageScore == null ? null : (100 - Number(leader.averageScore)) * 100,
      winRate: leader ? leader.wins / leader.comparableSamples : null,
      sampleCount: leader?.comparableSamples ?? 0,
      availability: leader ? leader.successes / leader.attempts : null,
      results: rows.map((row) => ({
        protocol: row.protocol,
        averageScore: row.averageScore,
        wins: row.wins,
        samples: row.comparableSamples,
        availability: row.attempts ? row.successes / row.attempts : 0,
      })),
    };
  });

  return { window: "7d" as const, cutoff, cells };
}

export async function GET(request: Request) {
  try {
    await ensureBenchmarkSchema();
    const window = new URL(request.url).searchParams.get("window") as WindowName | null;
    const payload = window === "7d" ? await sevenDayComparison() : await latestComparison();
    return Response.json(payload, { headers: { "cache-control": "private, max-age=15" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Comparison data unavailable";
    if (message.includes("no such table") || message.includes("no such column")) {
      return Response.json({ window: "now", cells: [], migrationPending: true });
    }
    return Response.json({ error: message }, { status: 500 });
  }
}
