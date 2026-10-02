import { ensureBenchmarkSchema, getD1 } from "../../../db";
import { publicCacheHeaders, readPublicCache, writePublicCache } from "../../../lib/http-cache";
import { bestOutputMode } from "../../../lib/quotes/protocols";
import { quoteSizes } from "../../../lib/quotes/sizes";
import { fixedRouteCount, getCatalog, resolveFixedRoutes, type PartnerId } from "../../../lib/routes/catalog";

const protocols: PartnerId[] = ["thorchain", "maya", "chainflip", "near-intents"];
const aggregateProtocolMask = "thorchain,chainflip,near-intents,maya";
type Period = "current" | "previous";
type Metric = {
  attempts: number;
  eligibleAttempts: number;
  expectedWins: number;
  successes: number;
  oracleSamples: number;
  oracleGapSumBps: number;
  wins: number;
  firstObservedAt: string | null;
};
type DailyRow = { day: string; pairId: string; metricsJson: string };
type RawRow = Metric & { period: Period; bucket: string; pairId: string; protocol: PartnerId };
type DailyPayload = {
  p?: Partial<Record<PartnerId, unknown[]>>;
  w?: Record<string, Partial<Record<PartnerId, number>>>;
};

function emptyMetric(): Metric {
  return { attempts: 0, eligibleAttempts: 0, expectedWins: 0, successes: 0, oracleSamples: 0, oracleGapSumBps: 0, wins: 0, firstObservedAt: null };
}

function addMetric(target: Metric, value: Metric) {
  target.attempts += value.attempts;
  target.eligibleAttempts += value.eligibleAttempts;
  target.expectedWins += value.expectedWins;
  target.successes += value.successes;
  target.oracleSamples += value.oracleSamples;
  target.oracleGapSumBps += value.oracleGapSumBps;
  target.wins += value.wins;
  if (value.firstObservedAt && (!target.firstObservedAt || value.firstObservedAt < target.firstObservedAt)) {
    target.firstObservedAt = value.firstObservedAt;
  }
}

function metricKey(period: Period, pairId: string, protocol: PartnerId) {
  return `${period}|${pairId}|${protocol}`;
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

function percent(value: number, total: number) {
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

function parseDailyMetric(payload: DailyPayload, protocol: PartnerId, supported: boolean): Metric {
  const values = payload.p?.[protocol] ?? [];
  const attempts = numeric(values[0]);
  const explicitEligibleAttempts = values.length > 5 ? numeric(values[5]) : null;
  return {
    attempts,
    eligibleAttempts: explicitEligibleAttempts ?? (supported ? attempts : 0),
    expectedWins: 0,
    successes: numeric(values[1]),
    oracleSamples: numeric(values[3]),
    oracleGapSumBps: numeric(values[4]),
    wins: numeric(payload.w?.[aggregateProtocolMask]?.[protocol]),
    firstObservedAt: null,
  };
}

async function loadDailyRows(amountId: string, startDay: string, endDay: string) {
  const result = await getD1().prepare(`
    SELECT day, pair_id AS pairId, metrics_json AS metricsJson
    FROM daily_comparison_metrics
    WHERE mode = ? AND amount_id = ? AND day >= ? AND day < ?
    ORDER BY day, pair_id
  `).bind(bestOutputMode, amountId, startDay, endDay).all<DailyRow>();
  return result.results;
}

async function loadRawRows(amountId: string, previousStart: string, currentStart: string) {
  const result = await getD1().prepare(`
    WITH attempts AS (
      SELECT r.id AS run_id, r.pair_id, r.initiated_at,
        CASE WHEN r.initiated_at >= ? THEN 'current' ELSE 'previous' END AS period,
        strftime('%Y-%m-%dT%H:00:00.000Z', CAST(unixepoch(r.initiated_at) / 7200 AS INTEGER) * 7200, 'unixepoch') AS bucket,
        q.protocol, q.status, q.error_code,
        CAST(q.expected_output_formatted AS REAL) AS output,
        q.oracle_gap_bps
      FROM benchmark_runs r
      JOIN protocol_quotes q ON q.run_id = r.id
      WHERE r.mode = ? AND r.amount_id = ? AND r.initiated_at >= ?
        AND r.oracle_captured_at IS NOT NULL
        AND r.completed_at IS NOT NULL AND r.status IN ('complete', 'partial')
    ), eligible_counts AS (
      SELECT run_id,
        SUM(CASE WHEN error_code = 'UNSUPPORTED_PAIR' THEN 0 ELSE 1 END) AS eligible_count
      FROM attempts
      GROUP BY run_id
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
      SELECT a.*, s.best_output, s.winner_count, e.eligible_count
      FROM attempts a
      LEFT JOIN run_stats s ON s.run_id = a.run_id
      LEFT JOIN eligible_counts e ON e.run_id = a.run_id
    )
    SELECT period, bucket, pair_id AS pairId, protocol,
      COUNT(*) AS attempts,
      SUM(CASE WHEN error_code = 'UNSUPPORTED_PAIR' THEN 0 ELSE 1 END) AS eligibleAttempts,
      SUM(CASE WHEN error_code = 'UNSUPPORTED_PAIR' OR eligible_count <= 0 THEN 0 ELSE 1.0 / eligible_count END) AS expectedWins,
      SUM(CASE WHEN status = 'quoted' THEN 1 ELSE 0 END) AS successes,
      SUM(CASE WHEN status = 'quoted' AND oracle_gap_bps IS NOT NULL THEN 1 ELSE 0 END) AS oracleSamples,
      SUM(CASE WHEN status = 'quoted' AND oracle_gap_bps IS NOT NULL THEN oracle_gap_bps ELSE 0 END) AS oracleGapSumBps,
      SUM(CASE WHEN status = 'quoted' AND output > 0 AND output = best_output THEN 1.0 / winner_count ELSE 0 END) AS wins
    FROM scored
    GROUP BY period, bucket, pair_id, protocol
    ORDER BY bucket, pair_id, protocol
  `).bind(currentStart, bestOutputMode, amountId, previousStart).all<RawRow>();
  return result.results.map((row) => ({
    ...row,
    attempts: numeric(row.attempts),
    eligibleAttempts: numeric(row.eligibleAttempts),
    expectedWins: numeric(row.expectedWins),
    successes: numeric(row.successes),
    oracleSamples: numeric(row.oracleSamples),
    oracleGapSumBps: numeric(row.oracleGapSumBps),
    wins: numeric(row.wins),
    firstObservedAt: numeric(row.eligibleAttempts) > 0 ? row.bucket : null,
  }));
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
    const amount = quoteSizes.find((item) => item.id === requestedAmountId) ?? quoteSizes[3];
    const catalog = await getCatalog({ d1: getD1(), allowStale: true, allowStatic: true });
    const { routes } = resolveFixedRoutes(catalog.assets, fixedRouteCount);
    const routeById = new Map(routes.map((route) => [route.id, route]));
    const metrics = new Map<string, Metric>();
    const timeline = new Map<string, Metric>();
    const now = new Date();
    let currentStart: string;
    let previousStart: string;
    let currentEnd: string;

    if (days === 1) {
      currentEnd = now.toISOString();
      currentStart = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
      previousStart = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString();
      const rows = await loadRawRows(amount.id, previousStart, currentStart);
      for (const row of rows) {
        const route = routeById.get(row.pairId);
        if (!route || !protocols.includes(row.protocol) || !route.partners.includes(row.protocol)) continue;
        const key = metricKey(row.period, row.pairId, row.protocol);
        const target = metrics.get(key) ?? emptyMetric();
        addMetric(target, row);
        metrics.set(key, target);
        if (row.period === "current") {
          const bucketTarget = timeline.get(timelineKey(row.bucket, row.protocol)) ?? emptyMetric();
          addMetric(bucketTarget, row);
          timeline.set(timelineKey(row.bucket, row.protocol), bucketTarget);
        }
      }
    } else {
      const today = utcDay(now);
      const currentStartDay = shiftUtcDay(today, -days);
      const previousStartDay = shiftUtcDay(today, -days * 2);
      currentStart = `${currentStartDay}T00:00:00.000Z`;
      previousStart = `${previousStartDay}T00:00:00.000Z`;
      currentEnd = `${today}T00:00:00.000Z`;
      const rows = await loadDailyRows(amount.id, previousStartDay, today);
      for (const row of rows) {
        const route = routeById.get(row.pairId);
        const payload = parseDailyPayload(row.metricsJson);
        if (!route || !payload) continue;
        const period: Period = row.day >= currentStartDay ? "current" : "previous";
        const rowMetrics = protocols.map((protocol) => ({
          protocol,
          supported: route.partners.includes(protocol),
          value: parseDailyMetric(payload, protocol, route.partners.includes(protocol)),
        }));
        const eligibleProtocolCount = rowMetrics.filter((item) => item.supported && item.value.eligibleAttempts > 0).length;
        for (const { protocol, supported, value } of rowMetrics) {
          if (!supported) continue;
          value.expectedWins = eligibleProtocolCount ? value.eligibleAttempts / eligibleProtocolCount : 0;
          value.firstObservedAt = value.eligibleAttempts > 0 ? `${row.day}T00:00:00.000Z` : null;
          const key = metricKey(period, row.pairId, protocol);
          const target = metrics.get(key) ?? emptyMetric();
          addMetric(target, value);
          metrics.set(key, target);
          if (period === "current") {
            const bucketTarget = timeline.get(timelineKey(row.day, protocol)) ?? emptyMetric();
            addMetric(bucketTarget, value);
            timeline.set(timelineKey(row.day, protocol), bucketTarget);
          }
        }
      }
    }

    const summaries = protocols.map((protocol) => {
      const current = emptyMetric();
      const previous = emptyMetric();
      const routeOracleAverages: number[] = [];
      for (const route of routes) {
        if (!route.partners.includes(protocol)) continue;
        const routeCurrent = metrics.get(metricKey("current", route.id, protocol)) ?? emptyMetric();
        addMetric(current, routeCurrent);
        addMetric(previous, metrics.get(metricKey("previous", route.id, protocol)) ?? emptyMetric());
        if (routeCurrent.oracleSamples > 0) routeOracleAverages.push(routeCurrent.oracleGapSumBps / routeCurrent.oracleSamples);
      }
      const winRate = percent(current.wins, current.eligibleAttempts);
      const winIndex = percent(current.wins, current.expectedWins);
      const previousWinIndex = percent(previous.wins, previous.expectedWins);
      const partialThresholdMs = days === 1 ? 3 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
      return {
        protocol,
        winIndex,
        winRate,
        availability: percent(current.successes, current.eligibleAttempts),
        medianRouteOracleGapBps: median(routeOracleAverages),
        supportedRoutes: routes.filter((route) => route.partners.includes(protocol)).length,
        eligibleChecks: current.eligibleAttempts,
        wins: current.wins,
        expectedWins: current.expectedWins,
        observedSince: current.firstObservedAt,
        partialPeriod: Boolean(current.firstObservedAt && new Date(current.firstObservedAt).getTime() - new Date(currentStart).getTime() > partialThresholdMs),
        previousWinIndex,
      };
    });

    const routeRows = routes.map((route) => {
      const currentByProtocol = new Map<PartnerId, Metric>();
      const previousByProtocol = new Map<PartnerId, Metric>();
      for (const protocol of protocols) {
        currentByProtocol.set(protocol, metrics.get(metricKey("current", route.id, protocol)) ?? emptyMetric());
        previousByProtocol.set(protocol, metrics.get(metricKey("previous", route.id, protocol)) ?? emptyMetric());
      }
      const currentWins = route.partners.reduce((sum, protocol) => sum + (currentByProtocol.get(protocol)?.wins ?? 0), 0);
      const previousWins = route.partners.reduce((sum, protocol) => sum + (previousByProtocol.get(protocol)?.wins ?? 0), 0);
      const results = protocols.map((protocol) => {
        const supported = route.partners.includes(protocol);
        const current = currentByProtocol.get(protocol)!;
        const previous = previousByProtocol.get(protocol)!;
        return {
          protocol,
          supported,
          winShare: supported ? percent(current.wins, currentWins) : null,
          availability: supported ? percent(current.successes, current.eligibleAttempts) : null,
          averageOracleGapBps: supported && current.oracleSamples ? current.oracleGapSumBps / current.oracleSamples : null,
          eligibleChecks: supported ? current.eligibleAttempts : 0,
          change: supported && currentWins > 0 && previousWins > 0
            ? current.wins / currentWins - previous.wins / previousWins
            : null,
        };
      });
      const ranked = results.filter((item) => item.supported && item.winShare != null)
        .sort((left, right) => Number(right.winShare) - Number(left.winShare));
      const previousLeader = [...route.partners]
        .map((protocol) => ({ protocol, wins: previousByProtocol.get(protocol)?.wins ?? 0 }))
        .sort((left, right) => right.wins - left.wins)[0];
      return {
        routeId: route.id,
        source: { id: route.source.id, symbol: route.source.symbol, chain: route.source.chain },
        destination: { id: route.destination.id, symbol: route.destination.symbol, chain: route.destination.chain },
        supportedProtocols: route.partners,
        comparisonCount: currentWins,
        leader: ranked[0]?.protocol ?? null,
        leaderWinShare: ranked[0]?.winShare ?? null,
        previousLeader: previousLeader?.wins ? previousLeader.protocol : null,
        leaderChanged: Boolean(ranked[0]?.protocol && previousLeader?.wins && ranked[0].protocol !== previousLeader.protocol),
        results,
      };
    }).sort((left, right) => Number(right.leaderWinShare ?? -1) - Number(left.leaderWinShare ?? -1)
      || right.comparisonCount - left.comparisonCount);

    const timelineBuckets = [...new Set([...timeline.keys()].map((key) => key.slice(0, key.lastIndexOf("|"))))].sort();
    const timelineRows = timelineBuckets.map((bucket) => ({
      bucket,
      results: protocols.map((protocol) => {
        const value = timeline.get(timelineKey(bucket, protocol)) ?? emptyMetric();
        return {
          protocol,
          winIndex: percent(value.wins, value.expectedWins),
          winRate: percent(value.wins, value.eligibleAttempts),
          eligibleChecks: value.eligibleAttempts,
        };
      }),
    }));

    const movers = routeRows.flatMap((route) => route.results
      .filter((result) => result.supported && result.change != null)
      .map((result) => ({
        routeId: route.routeId,
        source: route.source,
        destination: route.destination,
        protocol: result.protocol,
        change: result.change!,
        leaderChanged: route.leaderChanged,
      })))
      .sort((left, right) => Math.abs(right.change) - Math.abs(left.change))
      .slice(0, 8);

    const response = Response.json({
      generatedAt: now.toISOString(),
      period: { days, currentStart, currentEnd, previousStart },
      amount,
      definitions: {
        winIndex: "Actual best-quote wins divided by the fair-share wins expected from the number of eligible DEXes on each route. 1.00× is the neutral baseline. A sole valid quote still wins.",
        winRate: "Raw best-quote wins divided by eligible scheduled checks. It is shown with the underlying win and check counts for transparency.",
        availability: "Valid quotes divided by eligible scheduled checks. Unsupported routes are excluded.",
        oracle: "The median of each supported route's average deviation from the oracle, so one malformed quote cannot dominate the DEX-wide result.",
      },
      summaries,
      timeline: timelineRows,
      routes: routeRows,
      movers,
    }, { headers: publicCacheHeaders(900) });
    return writePublicCache(request, response);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Analytics unavailable" }, { status: 503 });
  }
}
