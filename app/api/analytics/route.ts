import { ensureBenchmarkSchema, getD1 } from "../../../db";
import { publicCacheHeaders, readPublicCache, writePublicCache } from "../../../lib/http-cache";
import { bestOutputMode } from "../../../lib/quotes/protocols";
import { quoteSizes } from "../../../lib/quotes/sizes";
import { fixedRouteCount, getCatalog, resolveFixedRoutes, type PartnerId } from "../../../lib/routes/catalog";

const protocols: PartnerId[] = ["thorchain", "maya", "chainflip", "near-intents"];
const maskProtocolOrder: PartnerId[] = ["thorchain", "chainflip", "near-intents", "maya"];
const aggregateProtocolMask = maskProtocolOrder.join(",");

type Metric = {
  attempts: number;
  eligibleAttempts: number;
  successes: number;
  oracleSamples: number;
  oracleGapSumBps: number;
  wins: number;
  firstObservedAt: string | null;
};
type PairwiseMetric = { wins: number; matchups: number };
type DailyRow = { day: string; pairId: string; amountId: string; metricsJson: string };
type RawRow = Metric & { bucket: string; pairId: string; amountId: string; protocol: PartnerId };
type PairwiseRow = { bucket: string; pairId: string; amountId: string; protocol: PartnerId; wins: number; matchups: number };
type DailyPayload = {
  p?: Partial<Record<PartnerId, unknown[]>>;
  w?: Record<string, Partial<Record<PartnerId, number>>>;
};

function emptyMetric(): Metric {
  return { attempts: 0, eligibleAttempts: 0, successes: 0, oracleSamples: 0, oracleGapSumBps: 0, wins: 0, firstObservedAt: null };
}

function addMetric(target: Metric, value: Metric) {
  target.attempts += value.attempts;
  target.eligibleAttempts += value.eligibleAttempts;
  target.successes += value.successes;
  target.oracleSamples += value.oracleSamples;
  target.oracleGapSumBps += value.oracleGapSumBps;
  target.wins += value.wins;
  if (value.firstObservedAt && (!target.firstObservedAt || value.firstObservedAt < target.firstObservedAt)) {
    target.firstObservedAt = value.firstObservedAt;
  }
}

function addPairwiseMetric<Key>(target: Map<Key, PairwiseMetric>, key: Key, wins: number, matchups: number) {
  const value = target.get(key) ?? { wins: 0, matchups: 0 };
  value.wins += wins;
  value.matchups += matchups;
  target.set(key, value);
}

function metricKey(pairId: string, amountId: string, protocol: PartnerId) {
  return `${pairId}|${amountId}|${protocol}`;
}

function pairwiseKey(pairId: string, amountId: string, protocol: PartnerId) {
  return `${pairId}|${amountId}|${protocol}`;
}

function timelineKey(bucket: string, protocol: PartnerId) {
  return `${bucket}|${protocol}`;
}

function utcDay(value: Date) {
  return value.toISOString().slice(0, 10);
}

function shiftUtcDay(day: string, amount: number) {
  const value = new Date(`${day}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return utcDay(value);
}

function numeric(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function ratio(value: number, total: number) {
  return total > 0 ? value / total : null;
}

function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function parseDailyPayload(metricsJson: string) {
  try {
    return JSON.parse(metricsJson) as DailyPayload;
  } catch {
    return null;
  }
}

function parseDailyMetric(payload: DailyPayload, protocol: PartnerId, supported: boolean, observedAt: string): Metric {
  const values = payload.p?.[protocol] ?? [];
  const attempts = numeric(values[0]);
  const explicitEligibleAttempts = values.length > 5 ? numeric(values[5]) : null;
  const eligibleAttempts = explicitEligibleAttempts ?? (supported ? attempts : 0);
  return {
    attempts,
    eligibleAttempts,
    successes: numeric(values[1]),
    oracleSamples: numeric(values[3]),
    oracleGapSumBps: numeric(values[4]),
    wins: numeric(payload.w?.[aggregateProtocolMask]?.[protocol]),
    firstObservedAt: eligibleAttempts > 0 ? observedAt : null,
  };
}

function dailyPairwiseResults(payload: DailyPayload, supportedProtocols: PartnerId[]) {
  const results = new Map<PartnerId, PairwiseMetric>();
  for (let leftIndex = 0; leftIndex < maskProtocolOrder.length; leftIndex += 1) {
    const left = maskProtocolOrder[leftIndex];
    if (!supportedProtocols.includes(left)) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < maskProtocolOrder.length; rightIndex += 1) {
      const right = maskProtocolOrder[rightIndex];
      if (!supportedProtocols.includes(right)) continue;
      const mask = `${left},${right}`;
      const leftSuccesses = numeric(payload.p?.[left]?.[1]);
      const rightSuccesses = numeric(payload.p?.[right]?.[1]);
      const leftAllWins = numeric(payload.w?.[mask]?.[left]);
      const rightAllWins = numeric(payload.w?.[mask]?.[right]);
      const atLeastOneQuote = leftAllWins + rightAllWins;
      const matchups = Math.max(0, Math.min(leftSuccesses, rightSuccesses, leftSuccesses + rightSuccesses - atLeastOneQuote));
      if (!matchups) continue;
      const leftSoleWins = Math.max(0, leftSuccesses - matchups);
      const rightSoleWins = Math.max(0, rightSuccesses - matchups);
      const leftHeadToHeadWins = Math.max(0, Math.min(matchups, leftAllWins - leftSoleWins));
      const rightHeadToHeadWins = Math.max(0, Math.min(matchups, rightAllWins - rightSoleWins));
      addPairwiseMetric(results, left, leftHeadToHeadWins, matchups);
      addPairwiseMetric(results, right, rightHeadToHeadWins, matchups);
    }
  }
  return results;
}

async function loadDailyRows(startDay: string, endDay: string) {
  const result = await getD1().prepare(`
    SELECT day, pair_id AS pairId, amount_id AS amountId, metrics_json AS metricsJson
    FROM daily_comparison_metrics
    WHERE mode = ? AND day >= ? AND day < ?
    ORDER BY day, pair_id, amount_id
  `).bind(bestOutputMode, startDay, endDay).all<DailyRow>();
  return result.results;
}

async function loadRawRows(startAt: string, endAt: string) {
  const result = await getD1().prepare(`
    WITH attempts AS (
      SELECT r.id AS run_id, r.pair_id, r.amount_id,
        strftime('%Y-%m-%dT%H:00:00.000Z', CAST(unixepoch(r.initiated_at) / 7200 AS INTEGER) * 7200, 'unixepoch') AS bucket,
        q.protocol, q.status, q.error_code,
        CAST(q.expected_output_formatted AS REAL) AS output,
        q.oracle_gap_bps
      FROM benchmark_runs r
      JOIN protocol_quotes q ON q.run_id = r.id
      WHERE r.mode = ? AND r.initiated_at >= ? AND r.initiated_at < ?
        AND r.oracle_captured_at IS NOT NULL
        AND r.completed_at IS NOT NULL AND r.status IN ('complete', 'partial')
    ), valid AS (
      SELECT *, MAX(output) OVER (PARTITION BY run_id) AS best_output
      FROM attempts
      WHERE status = 'quoted' AND output > 0
    ), run_stats AS (
      SELECT run_id, MAX(best_output) AS best_output,
        SUM(CASE WHEN output = best_output THEN 1 ELSE 0 END) AS winner_count
      FROM valid
      GROUP BY run_id
    ), scored AS (
      SELECT a.*, s.best_output, s.winner_count
      FROM attempts a
      LEFT JOIN run_stats s ON s.run_id = a.run_id
    )
    SELECT bucket, pair_id AS pairId, amount_id AS amountId, protocol,
      COUNT(*) AS attempts,
      SUM(CASE WHEN error_code = 'UNSUPPORTED_PAIR' THEN 0 ELSE 1 END) AS eligibleAttempts,
      SUM(CASE WHEN status = 'quoted' THEN 1 ELSE 0 END) AS successes,
      SUM(CASE WHEN status = 'quoted' AND oracle_gap_bps IS NOT NULL THEN 1 ELSE 0 END) AS oracleSamples,
      SUM(CASE WHEN status = 'quoted' AND oracle_gap_bps IS NOT NULL THEN oracle_gap_bps ELSE 0 END) AS oracleGapSumBps,
      SUM(CASE WHEN status = 'quoted' AND output > 0 AND output = best_output THEN 1.0 / winner_count ELSE 0 END) AS wins
    FROM scored
    GROUP BY bucket, pair_id, amount_id, protocol
    ORDER BY bucket, pair_id, amount_id, protocol
  `).bind(bestOutputMode, startAt, endAt).all<RawRow>();
  return result.results.map((row) => ({
    ...row,
    attempts: numeric(row.attempts),
    eligibleAttempts: numeric(row.eligibleAttempts),
    successes: numeric(row.successes),
    oracleSamples: numeric(row.oracleSamples),
    oracleGapSumBps: numeric(row.oracleGapSumBps),
    wins: numeric(row.wins),
    firstObservedAt: numeric(row.eligibleAttempts) > 0 ? row.bucket : null,
  }));
}

async function loadPairwiseRows(startAt: string, endAt: string) {
  const result = await getD1().prepare(`
    WITH valid AS (
      SELECT r.id AS run_id, r.pair_id, r.amount_id,
        strftime('%Y-%m-%dT%H:00:00.000Z', CAST(unixepoch(r.initiated_at) / 7200 AS INTEGER) * 7200, 'unixepoch') AS bucket,
        q.protocol, CAST(q.expected_output_formatted AS REAL) AS output
      FROM benchmark_runs r
      JOIN protocol_quotes q ON q.run_id = r.id
      WHERE r.mode = ? AND r.initiated_at >= ? AND r.initiated_at < ?
        AND r.oracle_captured_at IS NOT NULL
        AND r.completed_at IS NOT NULL AND r.status IN ('complete', 'partial')
        AND q.status = 'quoted' AND CAST(q.expected_output_formatted AS REAL) > 0
    ), pairs AS (
      SELECT a.bucket, a.pair_id, a.amount_id,
        a.protocol AS left_protocol, a.output AS left_output,
        b.protocol AS right_protocol, b.output AS right_output
      FROM valid a
      JOIN valid b ON b.run_id = a.run_id AND a.protocol < b.protocol
    ), matchups AS (
      SELECT bucket, pair_id, amount_id, left_protocol AS protocol, left_output AS output, right_output AS opponent_output FROM pairs
      UNION ALL
      SELECT bucket, pair_id, amount_id, right_protocol AS protocol, right_output AS output, left_output AS opponent_output FROM pairs
    )
    SELECT bucket, pair_id AS pairId, amount_id AS amountId, protocol,
      SUM(CASE WHEN output > opponent_output THEN 1 WHEN output = opponent_output THEN 0.5 ELSE 0 END) AS wins,
      COUNT(*) AS matchups
    FROM matchups
    GROUP BY bucket, pair_id, amount_id, protocol
    ORDER BY bucket, pair_id, amount_id, protocol
  `).bind(bestOutputMode, startAt, endAt).all<PairwiseRow>();
  return result.results.map((row) => ({ ...row, wins: numeric(row.wins), matchups: numeric(row.matchups) }));
}

export async function GET(request: Request) {
  try {
    const cached = await readPublicCache(request);
    if (cached) return cached;
    await ensureBenchmarkSchema();
    const url = new URL(request.url);
    const requestedDays = Number(url.searchParams.get("days") ?? 7);
    const days = requestedDays === 1 || requestedDays === 30 ? requestedDays : 7;
    const requestedAmountId = url.searchParams.get("amountId") ?? "50000";
    const selectedAmount = quoteSizes.find((item) => item.id === requestedAmountId) ?? quoteSizes[3];
    const catalog = await getCatalog({ d1: getD1(), allowStale: true, allowStatic: true });
    const { routes } = resolveFixedRoutes(catalog.assets, fixedRouteCount);
    const routeById = new Map(routes.map((route) => [route.id, route]));
    const requestedRouteId = url.searchParams.get("routeId")?.trim();
    const selectedRoute = routeById.get(requestedRouteId ?? "") ?? routes[0];
    if (!selectedRoute) return Response.json({ error: "No benchmark routes are available" }, { status: 503 });

    const metrics = new Map<string, Metric>();
    const pairwise = new Map<string, PairwiseMetric>();
    const timeline = new Map<string, PairwiseMetric>();
    const now = new Date();
    let currentStart: string;
    let currentEnd: string;

    if (days === 1) {
      currentEnd = now.toISOString();
      currentStart = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
      const rows = await loadRawRows(currentStart, currentEnd);
      for (const row of rows) {
        const route = routeById.get(row.pairId);
        if (!route || !protocols.includes(row.protocol) || !route.partners.includes(row.protocol)) continue;
        const key = metricKey(row.pairId, row.amountId, row.protocol);
        const target = metrics.get(key) ?? emptyMetric();
        addMetric(target, row);
        metrics.set(key, target);
      }
      const pairwiseRows = await loadPairwiseRows(currentStart, currentEnd);
      for (const row of pairwiseRows) {
        const route = routeById.get(row.pairId);
        if (!route || !protocols.includes(row.protocol) || !route.partners.includes(row.protocol)) continue;
        addPairwiseMetric(pairwise, pairwiseKey(row.pairId, row.amountId, row.protocol), row.wins, row.matchups);
        if (row.pairId === selectedRoute.id && row.amountId === selectedAmount.id) {
          addPairwiseMetric(timeline, timelineKey(row.bucket, row.protocol), row.wins, row.matchups);
        }
      }
    } else {
      const today = utcDay(now);
      const currentStartDay = shiftUtcDay(today, -days);
      currentStart = `${currentStartDay}T00:00:00.000Z`;
      currentEnd = `${today}T00:00:00.000Z`;
      const rows = await loadDailyRows(currentStartDay, today);
      for (const row of rows) {
        const route = routeById.get(row.pairId);
        const payload = parseDailyPayload(row.metricsJson);
        if (!route || !payload) continue;
        for (const protocol of protocols) {
          if (!route.partners.includes(protocol)) continue;
          const value = parseDailyMetric(payload, protocol, true, `${row.day}T00:00:00.000Z`);
          const key = metricKey(row.pairId, row.amountId, protocol);
          const target = metrics.get(key) ?? emptyMetric();
          addMetric(target, value);
          metrics.set(key, target);
        }
        for (const [protocol, value] of dailyPairwiseResults(payload, route.partners)) {
          addPairwiseMetric(pairwise, pairwiseKey(row.pairId, row.amountId, protocol), value.wins, value.matchups);
          if (row.pairId === selectedRoute.id && row.amountId === selectedAmount.id) {
            addPairwiseMetric(timeline, timelineKey(row.day, protocol), value.wins, value.matchups);
          }
        }
      }
    }

    const overview = protocols.map((protocol) => {
      const total = emptyMetric();
      for (const route of routes) {
        if (!route.partners.includes(protocol)) continue;
        for (const amount of quoteSizes) addMetric(total, metrics.get(metricKey(route.id, amount.id, protocol)) ?? emptyMetric());
      }
      const supportedRoutes = routes.filter((route) => route.partners.includes(protocol)).length;
      return {
        protocol,
        supportedRoutes,
        coverage: ratio(supportedRoutes, routes.length),
        availability: ratio(total.successes, total.eligibleAttempts),
        eligibleChecks: total.eligibleAttempts,
        observedSince: total.firstObservedAt,
      };
    });

    const routeSummaries = protocols.map((protocol) => {
      const supported = selectedRoute.partners.includes(protocol);
      const total = emptyMetric();
      const pairwiseTotal: PairwiseMetric = { wins: 0, matchups: 0 };
      const sizeOracleAverages: number[] = [];
      if (supported) {
        for (const amount of quoteSizes) {
          const value = metrics.get(metricKey(selectedRoute.id, amount.id, protocol)) ?? emptyMetric();
          addMetric(total, value);
          if (value.oracleSamples > 0) sizeOracleAverages.push(value.oracleGapSumBps / value.oracleSamples);
          const direct = pairwise.get(pairwiseKey(selectedRoute.id, amount.id, protocol));
          if (direct) {
            pairwiseTotal.wins += direct.wins;
            pairwiseTotal.matchups += direct.matchups;
          }
        }
      }
      return {
        protocol,
        supported,
        bestQuoteRate: supported ? ratio(total.wins, total.eligibleAttempts) : null,
        wins: supported ? total.wins : 0,
        eligibleChecks: supported ? total.eligibleAttempts : 0,
        availability: supported ? ratio(total.successes, total.eligibleAttempts) : null,
        pairwiseBeatRate: supported ? ratio(pairwiseTotal.wins, pairwiseTotal.matchups) : null,
        pairwiseMatchups: supported ? pairwiseTotal.matchups : 0,
        medianOracleGapBps: supported ? median(sizeOracleAverages) : null,
      };
    });

    const sizeRows = quoteSizes.map((amount) => {
      const results = protocols.map((protocol) => {
        const supported = selectedRoute.partners.includes(protocol);
        const value = metrics.get(metricKey(selectedRoute.id, amount.id, protocol)) ?? emptyMetric();
        const direct = pairwise.get(pairwiseKey(selectedRoute.id, amount.id, protocol)) ?? { wins: 0, matchups: 0 };
        return {
          protocol,
          supported,
          bestQuoteRate: supported ? ratio(value.wins, value.eligibleAttempts) : null,
          wins: supported ? value.wins : 0,
          eligibleChecks: supported ? value.eligibleAttempts : 0,
          availability: supported ? ratio(value.successes, value.eligibleAttempts) : null,
          pairwiseBeatRate: supported ? ratio(direct.wins, direct.matchups) : null,
          pairwiseMatchups: supported ? direct.matchups : 0,
          medianOracleGapBps: supported && value.oracleSamples ? value.oracleGapSumBps / value.oracleSamples : null,
          rank: null as number | null,
        };
      });
      const ranked = results.filter((result) => result.supported && result.bestQuoteRate != null)
        .sort((left, right) => Number(right.bestQuoteRate) - Number(left.bestQuoteRate));
      ranked.forEach((result, index) => {
        const previous = ranked[index - 1];
        result.rank = previous && previous.bestQuoteRate === result.bestQuoteRate ? previous.rank : index + 1;
      });
      return { amount, leader: ranked[0]?.protocol ?? null, results };
    });

    const timelineBuckets = [...new Set([...timeline.keys()].map((key) => key.slice(0, key.lastIndexOf("|"))))].sort();
    const timelineRows = timelineBuckets.map((bucket) => ({
      bucket,
      results: protocols.map((protocol) => {
        const value = timeline.get(timelineKey(bucket, protocol)) ?? { wins: 0, matchups: 0 };
        return { protocol, pairwiseBeatRate: ratio(value.wins, value.matchups), matchups: value.matchups };
      }),
    }));

    return writePublicCache(request, Response.json({
      generatedAt: now.toISOString(),
      period: { days, currentStart, currentEnd },
      selectedAmount,
      selectedRoute: {
        routeId: selectedRoute.id,
        source: { id: selectedRoute.source.id, symbol: selectedRoute.source.symbol, chain: selectedRoute.source.chain },
        destination: { id: selectedRoute.destination.id, symbol: selectedRoute.destination.symbol, chain: selectedRoute.destination.chain },
        supportedProtocols: selectedRoute.partners,
      },
      routes: routes.map((route) => ({
        routeId: route.id,
        source: { id: route.source.id, symbol: route.source.symbol, chain: route.source.chain },
        destination: { id: route.destination.id, symbol: route.destination.symbol, chain: route.destination.chain },
        supportedProtocols: route.partners,
      })),
      overview,
      routeSummaries,
      sizeRows,
      timeline: timelineRows,
      definitions: {
        bestQuoteRate: "Best-quote wins divided by eligible scheduled checks on this route. A sole valid quote still wins.",
        pairwise: "The share of direct quote matchups won when both DEXes returned valid quotes. Second and third place receive credit for the competing quotes they beat.",
        availability: "Valid quotes divided by eligible scheduled checks. Unsupported routes are excluded.",
        oracle: "Median execution deviation across the seven tracked sizes relative to the synchronized oracle.",
      },
    }, { headers: publicCacheHeaders(900) }));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Analytics unavailable" }, { status: 503 });
  }
}
