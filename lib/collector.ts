import { ensureBenchmarkSchema } from "../db";
import { benchmarkCatalogGraceMs, fixedRouteCount, getCatalog, resolveFixedRoutes } from "./routes/catalog";
import { quoteSizes } from "./quotes/sizes";
import { runSelectedBenchmark, type BenchmarkArchiveRecord } from "./quotes/run";
import { bestOutputMode } from "./quotes/protocols";
import type { ExecutionMode, NormalizedQuote, ProtocolId } from "./quotes/types";

const protocols: ProtocolId[] = ["thorchain", "chainflip", "near-intents", "maya"];
const jobsPerMessage = 20;
const workerConcurrency = 1;
const detailRetentionDays = 8;
const aggregateRetentionDays = 2_000;
const hourlyTrendBucketSeconds = 60 * 60;
const fourHourTrendBucketSeconds = 4 * hourlyTrendBucketSeconds;
const hourlyTrendRetentionDays = 8;
const fourHourTrendRetentionDays = 32;
const deleteBatchSize = 1_000;
const deleteBatchesPerMaintenance = 80;

export type CollectorJob = { routeId: string; amountId: string; mode: ExecutionMode };
export type CollectorBundle = {
  sweepId: string;
  scheduledFor: string;
  bundleIndex: number;
  jobs: CollectorJob[];
};

export type CollectorEnvironment = {
  DB: D1Database;
  ARCHIVE: R2Bucket;
  BENCHMARK_QUEUE: Queue<CollectorBundle>;
  VOLUME_COLLECTION_ENABLED?: string;
};

function chunks<T>(items: T[], size: number) {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

function safeTimestamp(value: string) {
  return value.replaceAll(":", "-");
}

function normalizedQuote(quote: NormalizedQuote) {
  return {
    protocol: quote.protocol,
    strategy: quote.strategy,
    status: quote.status,
    expectedOutputBaseUnits: quote.expectedOutputBaseUnits,
    expectedOutputFormatted: quote.expectedOutputFormatted,
    oracleGapBps: quote.oracleGapBps,
    quotedFeeUsd: quote.quotedFeeUsd,
    estimatedDurationSeconds: quote.estimatedDurationSeconds,
    requestStartedAt: quote.requestStartedAt,
    responseReceivedAt: quote.responseReceivedAt,
    quoteExpiresAt: quote.quoteExpiresAt,
    responseHttpStatus: quote.responseHttpStatus,
    responseLatencyMs: quote.responseLatencyMs,
    errorCode: quote.errorCode,
    errorMessage: quote.errorMessage,
  };
}

function normalizedRecord(record: BenchmarkArchiveRecord) {
  return {
    runId: record.runId,
    routeId: record.routeId,
    amountId: record.amountId,
    mode: record.mode,
    initiatedAt: record.initiatedAt,
    completedAt: record.completedAt,
    maxRequestSkewMs: record.maxRequestSkewMs,
    oracle: record.oracle,
    request: {
      pairId: record.request.pairId,
      source: record.request.source,
      destination: record.request.destination,
      sourceAmountBaseUnits: record.request.sourceAmountBaseUnits,
      sourceAmountUsd: record.request.sourceAmountUsd,
      sourcePriceUsd: record.request.sourcePriceUsd,
      mode: record.request.mode,
      slippageToleranceBps: record.request.slippageToleranceBps,
    },
    quotes: record.quotes.map(normalizedQuote),
  };
}

async function gzip(value: unknown) {
  const source = new Blob([JSON.stringify(value)]).stream();
  const compressed = source.pipeThrough(new CompressionStream("gzip"));
  return new Response(compressed).arrayBuffer();
}

async function archiveBundle(bucket: R2Bucket, bundle: CollectorBundle, records: BenchmarkArchiveRecord[]) {
  const timestamp = safeTimestamp(bundle.scheduledFor);
  const base = `${bundle.scheduledFor.slice(0, 10)}/${timestamp}/bundle-${String(bundle.bundleIndex).padStart(2, "0")}`;
  const normalizedArchiveKey = `normalized/${base}.json.gz`;
  const rawArchiveKey = `raw/${base}.json.gz`;
  const metadata = { sweepId: bundle.sweepId, bundleIndex: String(bundle.bundleIndex), scheduledFor: bundle.scheduledFor };
  const [normalizedBody, rawBody] = await Promise.all([
    gzip({ ...metadata, records: records.map(normalizedRecord) }),
    gzip({ ...metadata, records }),
  ]);
  const uploads = await Promise.all([
    bucket.put(normalizedArchiveKey, normalizedBody, {
      httpMetadata: { contentType: "application/json", contentEncoding: "gzip" },
      customMetadata: metadata,
    }),
    bucket.put(rawArchiveKey, rawBody, {
      httpMetadata: { contentType: "application/json", contentEncoding: "gzip" },
      customMetadata: metadata,
    }),
  ]);
  if (uploads.some((upload) => !upload)) throw new Error("R2 archive upload returned no object");
  return { normalizedArchiveKey, rawArchiveKey };
}

export async function enqueueScheduledSweep(scheduledTime: number, environment: CollectorEnvironment) {
  await ensureBenchmarkSchema();
  const scheduledFor = new Date(scheduledTime).toISOString();
  const sweepId = `sweep:${scheduledFor}`;
  const d1 = environment.DB;
  const existing = await d1.prepare("SELECT status FROM collector_sweeps WHERE id = ?").bind(sweepId).first<{ status: string }>();
  if (existing?.status === "complete") return { sweepId, scheduledFor, skipped: true, reason: "Sweep already complete" };

  let catalog;
  try {
    catalog = await getCatalog({ d1, allowStale: true, maxStaleMs: benchmarkCatalogGraceMs });
    if (catalog.warning) {
      console.warn("Benchmark collection is using the last known route catalog", {
        sweepId,
        catalogSource: catalog.source,
        reason: catalog.warning,
      });
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Route catalog refresh failed";
    const now = new Date().toISOString();
    if (!existing) {
      await d1.prepare(`
        INSERT INTO collector_sweeps (
          id, scheduled_for, status, route_count, job_count, bundle_count,
          completed_jobs, failed_jobs, started_at, completed_at, missing_routes_json
        ) VALUES (?, ?, 'failed', 0, 0, 0, 0, 0, ?, ?, '[]')
      `).bind(sweepId, scheduledFor, now, now).run();
    }
    console.warn("Benchmark collection paused because fresh catalog pricing is unavailable", { sweepId, reason });
    return { sweepId, scheduledFor, skipped: true, reason: `Collection paused: ${reason}` };
  }
  const now = new Date().toISOString();
  const { routes, missingRouteIds } = resolveFixedRoutes(catalog.assets, fixedRouteCount);
  const jobs = routes.flatMap((route) => quoteSizes.map((size) => ({ routeId: route.id, amountId: size.id, mode: bestOutputMode })));
  const bundles = chunks(jobs, jobsPerMessage).map((bundleJobs, bundleIndex): CollectorBundle => ({ sweepId, scheduledFor, bundleIndex, jobs: bundleJobs }));

  if (!existing) {
    await d1.prepare(`
      INSERT INTO collector_sweeps (
        id, scheduled_for, status, route_count, job_count, bundle_count,
        completed_jobs, failed_jobs, started_at, missing_routes_json
      ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
    `).bind(
      sweepId,
      scheduledFor,
      jobs.length ? "pending" : "failed",
      routes.length,
      jobs.length,
      bundles.length,
      now,
      JSON.stringify(missingRouteIds),
    ).run();
    await d1.batch(bundles.map((bundle) => d1.prepare(`
      INSERT INTO collector_bundles (id, sweep_id, bundle_index, status, job_count)
      VALUES (?, ?, ?, 'pending', ?)
    `).bind(`${sweepId}:${bundle.bundleIndex}`, sweepId, bundle.bundleIndex, bundle.jobs.length)));
  }
  const storedBundles = existing
    ? await d1.prepare("SELECT bundle_index AS bundleIndex, status FROM collector_bundles WHERE sweep_id = ?").bind(sweepId).all<{ bundleIndex: number; status: string }>()
    : { results: [] as Array<{ bundleIndex: number; status: string }> };
  const completedIndexes = new Set(storedBundles.results.filter((bundle) => bundle.status === "complete").map((bundle) => bundle.bundleIndex));
  const pendingBundles = bundles.filter((bundle) => !completedIndexes.has(bundle.bundleIndex));
  if (pendingBundles.length) {
    await environment.BENCHMARK_QUEUE.sendBatch(pendingBundles.map((body) => ({ body, contentType: "json" as const })));
    await d1.prepare("UPDATE collector_sweeps SET status = 'running' WHERE id = ?").bind(sweepId).run();
  } else if (!jobs.length) {
    await d1.prepare("UPDATE collector_sweeps SET completed_at = ? WHERE id = ?").bind(now, sweepId).run();
  }
  return {
    sweepId,
    scheduledFor,
    skipped: false,
    resumed: Boolean(existing),
    routes: routes.length,
    missingRoutes: missingRouteIds,
    jobs: jobs.length,
    bundles: pendingBundles.length,
  };
}

async function updateSweepProgress(sweepId: string, d1: D1Database) {
  const now = new Date().toISOString();
  await d1.prepare(`
    UPDATE collector_sweeps SET
      completed_jobs = COALESCE((SELECT SUM(completed_jobs) FROM collector_bundles WHERE sweep_id = ?), 0),
      failed_jobs = COALESCE((SELECT SUM(failed_jobs) FROM collector_bundles WHERE sweep_id = ?), 0),
      status = CASE
        WHEN COALESCE((SELECT SUM(completed_jobs + failed_jobs) FROM collector_bundles WHERE sweep_id = ?), 0) < job_count THEN 'running'
        WHEN COALESCE((SELECT SUM(failed_jobs) FROM collector_bundles WHERE sweep_id = ?), 0) > 0
          OR EXISTS (SELECT 1 FROM collector_bundles WHERE sweep_id = ? AND status IN ('partial', 'failed'))
          OR route_count < ? THEN 'partial'
        ELSE 'complete'
      END,
      completed_at = CASE
        WHEN COALESCE((SELECT SUM(completed_jobs + failed_jobs) FROM collector_bundles WHERE sweep_id = ?), 0) >= job_count THEN ?
        ELSE completed_at
      END
    WHERE id = ?
  `).bind(sweepId, sweepId, sweepId, sweepId, sweepId, fixedRouteCount, sweepId, now, sweepId).run();
  return d1.prepare("SELECT status, scheduled_for AS scheduledFor FROM collector_sweeps WHERE id = ?")
    .bind(sweepId)
    .first<{ status: string; scheduledFor: string }>();
}

function bucketRange(timestamp: string, bucketSeconds: number) {
  const bucketMs = bucketSeconds * 1000;
  const startMs = Math.floor(new Date(timestamp).getTime() / bucketMs) * bucketMs;
  return {
    start: new Date(startMs).toISOString(),
    end: new Date(startMs + bucketMs).toISOString(),
  };
}

async function refreshTrendBucketRange(start: string, end: string, bucketSeconds: number, d1: D1Database) {
  await d1.prepare("DELETE FROM trend_buckets WHERE bucket_seconds = ? AND bucket_start >= ? AND bucket_start < ?")
    .bind(bucketSeconds, start, end)
    .run();
  await d1.prepare(`
    INSERT OR REPLACE INTO trend_buckets (
      id, bucket_start, bucket_seconds, pair_id, amount_id, mode,
      samples_json, latest_at
    )
    WITH bucketed_runs AS (
      SELECT r.id, r.pair_id, r.amount_id, r.mode, r.initiated_at,
        strftime(
          '%Y-%m-%dT%H:%M:%fZ',
          CAST(unixepoch(r.initiated_at) / ? AS INTEGER) * ?,
          'unixepoch'
        ) AS bucket_start
      FROM benchmark_runs r
      WHERE r.initiated_at >= ? AND r.initiated_at < ?
        AND r.oracle_captured_at IS NOT NULL
        AND r.completed_at IS NOT NULL AND r.status IN ('complete', 'partial')
    )
    SELECT
      CAST(? AS TEXT) || '|' || bucket_start || '|' || pair_id || '|' || amount_id || '|' || mode,
      bucket_start,
      ?,
      pair_id,
      amount_id,
      mode,
      json_group_array(json_object(
        'runId', id,
        'initiatedAt', initiated_at,
        'quotes', json(COALESCE((
          SELECT json_group_array(json_object(
            'protocol', q.protocol,
            'output', CAST(q.expected_output_formatted AS REAL),
            'oracleGapBps', q.oracle_gap_bps
          ))
          FROM protocol_quotes q
          WHERE q.run_id = bucketed_runs.id
            AND q.status = 'quoted'
            AND CAST(q.expected_output_formatted AS REAL) > 0
            AND q.oracle_gap_bps IS NOT NULL
        ), '[]'))
      )),
      MAX(initiated_at)
    FROM bucketed_runs
    GROUP BY bucket_start, pair_id, amount_id, mode
  `).bind(bucketSeconds, bucketSeconds, start, end, bucketSeconds, bucketSeconds).run();
}

async function refreshTrendBucketsForTimestamp(timestamp: string, d1: D1Database) {
  for (const bucketSeconds of [hourlyTrendBucketSeconds, fourHourTrendBucketSeconds]) {
    const range = bucketRange(timestamp, bucketSeconds);
    await refreshTrendBucketRange(range.start, range.end, bucketSeconds, d1);
  }
}

export async function processCollectorBundle(bundle: CollectorBundle, environment: CollectorEnvironment) {
  await ensureBenchmarkSchema();
  const d1 = environment.DB;
  const bundleId = `${bundle.sweepId}:${bundle.bundleIndex}`;
  const stored = await d1.prepare("SELECT status FROM collector_bundles WHERE id = ?").bind(bundleId).first<{ status: string }>();
  if (stored?.status === "complete") return { bundleId, skipped: true, completed: bundle.jobs.length, failed: 0 };
  const startedAt = new Date().toISOString();
  await d1.prepare(`
    UPDATE collector_bundles
    SET status = 'running', attempts = attempts + 1, started_at = ?, error_message = NULL
    WHERE id = ?
  `).bind(startedAt, bundleId).run();

  const records: BenchmarkArchiveRecord[] = [];
  const failures: string[] = [];
  let nextJob = 0;
  const worker = async () => {
    while (nextJob < bundle.jobs.length) {
      const job = bundle.jobs[nextJob++];
      try {
        const result = await runSelectedBenchmark(job.routeId, job.amountId, {
          sweepId: bundle.sweepId,
          bundleIndex: bundle.bundleIndex,
        });
        records.push(result.archive);
      } catch (error) {
        failures.push(`${job.routeId}/${job.amountId}/${job.mode}: ${error instanceof Error ? error.message : "Unknown collector failure"}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(workerConcurrency, bundle.jobs.length) }, () => worker()));

  let archiveKeys: { normalizedArchiveKey: string | null; rawArchiveKey: string | null } = { normalizedArchiveKey: null, rawArchiveKey: null };
  let archiveError: string | null = null;
  if (records.length) {
    try {
      archiveKeys = await archiveBundle(environment.ARCHIVE, bundle, records);
    } catch (error) {
      archiveError = `Archive upload failed: ${error instanceof Error ? error.message : "Unknown R2 error"}`;
    }
  }
  const completedAt = new Date().toISOString();
  const status = failures.length || archiveError ? (records.length ? "partial" : "failed") : "complete";
  const storedErrors = [...failures.slice(0, 5), ...(archiveError ? [archiveError] : [])];
  await d1.prepare(`
    UPDATE collector_bundles SET
      status = ?, completed_jobs = ?, failed_jobs = ?, normalized_archive_key = ?,
      raw_archive_key = ?, completed_at = ?, error_message = ?
    WHERE id = ?
  `).bind(status, records.length, failures.length, archiveKeys.normalizedArchiveKey, archiveKeys.rawArchiveKey, completedAt, storedErrors.join("\n") || null, bundleId).run();
  const sweep = await updateSweepProgress(bundle.sweepId, d1);
  if (sweep && sweep.status !== "pending" && sweep.status !== "running") {
    await refreshTrendBucketsForTimestamp(sweep.scheduledFor, d1);
    const { refreshVolumeQuoteHour } = await import("./volume/collector");
    try {
      await refreshVolumeQuoteHour(Date.parse(sweep.scheduledFor), environment);
    } catch {
      console.warn("Volume quote summary refresh failed; benchmark collection is unaffected");
    }
  }

  if (archiveError) throw new Error(archiveError);
  if (failures.length) throw new Error(`${failures.length} collector jobs failed`);
  return { bundleId, skipped: false, completed: records.length, failed: failures.length, ...archiveKeys };
}

function protocolMasks() {
  const masks: ProtocolId[][] = [];
  for (let mask = 0; mask < (1 << protocols.length); mask += 1) {
    const selected = protocols.filter((_, index) => (mask & (1 << index)) !== 0);
    if (selected.length >= 2) masks.push(selected);
  }
  // Keep the all-protocol mask first so the compact payload has a stable,
  // predictable order across daily rebuilds.
  return masks.sort((left, right) => right.length - left.length);
}

async function aggregateDay(day: string, d1: D1Database) {
  const start = `${day}T00:00:00.000Z`;
  const end = new Date(new Date(start).getTime() + 24 * 60 * 60 * 1000).toISOString();
  const maskProtocols = protocolMasks().flatMap((selected) => {
    const mask = selected.join(",");
    return selected.map((protocol) => `('${mask}', '${protocol}')`);
  }).join(",\n        ");
  const removeExisting = d1.prepare("DELETE FROM daily_comparison_metrics WHERE day = ?").bind(day);
  const insertCompact = d1.prepare(`
    INSERT INTO daily_comparison_metrics (
      id, day, pair_id, amount_id, mode, metrics_json, latest_at
    )
    WITH mask_protocols(mask, protocol) AS (
      VALUES ${maskProtocols}
    ), attempts AS (
      SELECT r.id AS run_id, r.pair_id, r.amount_id, r.mode, r.initiated_at,
        q.protocol, q.status, CAST(q.expected_output_formatted AS REAL) AS output,
        q.oracle_gap_bps, q.error_code
      FROM benchmark_runs r
      JOIN protocol_quotes q ON q.run_id = r.id
      WHERE r.initiated_at >= ? AND r.initiated_at < ?
        AND r.mode = 'optimized'
        AND r.oracle_captured_at IS NOT NULL
        AND r.completed_at IS NOT NULL AND r.status IN ('complete', 'partial')
    ), run_validity AS (
      SELECT run_id, COUNT(*) AS valid_count
      FROM attempts
      WHERE status = 'quoted' AND output > 0
      GROUP BY run_id
    ), base_metrics AS (
      SELECT a.pair_id, a.amount_id, a.mode, a.protocol,
        COUNT(*) AS attempts,
        SUM(CASE WHEN a.error_code = 'UNSUPPORTED_PAIR' THEN 0 ELSE 1 END) AS eligible_attempts,
        SUM(CASE WHEN a.status = 'quoted' THEN 1 ELSE 0 END) AS successes,
        SUM(CASE WHEN a.status = 'quoted' AND v.valid_count >= 1 THEN 1 ELSE 0 END) AS comparable_samples,
        SUM(CASE WHEN a.status = 'quoted' AND a.oracle_gap_bps IS NOT NULL THEN 1 ELSE 0 END) AS oracle_samples,
        SUM(CASE WHEN a.status = 'quoted' AND a.oracle_gap_bps IS NOT NULL THEN a.oracle_gap_bps ELSE 0 END) AS oracle_gap_sum_bps,
        MAX(a.initiated_at) AS latest_at
      FROM attempts a
      LEFT JOIN run_validity v ON v.run_id = a.run_id
      GROUP BY a.pair_id, a.amount_id, a.mode, a.protocol
    ), valid AS (
      SELECT a.*, mp.mask,
        MAX(a.output) OVER (PARTITION BY mp.mask, a.run_id) AS best_output
      FROM attempts a
      JOIN mask_protocols mp ON mp.protocol = a.protocol
      WHERE a.status = 'quoted' AND a.output > 0
    ), run_stats AS (
      SELECT mask, run_id, MAX(best_output) AS best_output,
        SUM(CASE WHEN output = best_output THEN 1 ELSE 0 END) AS winner_count
      FROM valid
      GROUP BY mask, run_id
    ), win_metrics AS (
      SELECT v.pair_id, v.amount_id, v.mode, v.mask, v.protocol,
        SUM(CASE WHEN v.output = r.best_output THEN 1.0 / r.winner_count ELSE 0 END) AS wins
      FROM valid v
      JOIN run_stats r ON r.mask = v.mask AND r.run_id = v.run_id
      GROUP BY v.pair_id, v.amount_id, v.mode, v.mask, v.protocol
    ), protocol_payloads AS (
      SELECT pair_id, amount_id, mode,
        json_group_object(protocol, json_array(
          attempts, successes, comparable_samples, oracle_samples, oracle_gap_sum_bps, eligible_attempts
        )) AS protocols_json,
        MAX(latest_at) AS latest_at
      FROM base_metrics
      GROUP BY pair_id, amount_id, mode
    ), cell_masks AS (
      SELECT DISTINCT b.pair_id, b.amount_id, b.mode, mp.mask
      FROM base_metrics b
      CROSS JOIN (SELECT DISTINCT mask FROM mask_protocols) mp
    ), mask_payloads AS (
      SELECT c.pair_id, c.amount_id, c.mode, c.mask,
        json_group_object(mp.protocol, COALESCE(w.wins, 0)) AS mask_json
      FROM cell_masks c
      JOIN mask_protocols mp ON mp.mask = c.mask
      LEFT JOIN win_metrics w
        ON w.pair_id = c.pair_id AND w.amount_id = c.amount_id AND w.mode = c.mode
        AND w.mask = c.mask AND w.protocol = mp.protocol
      GROUP BY c.pair_id, c.amount_id, c.mode, c.mask
    ), win_payloads AS (
      SELECT pair_id, amount_id, mode,
        json_group_object(mask, json(mask_json)) AS wins_json
      FROM mask_payloads
      GROUP BY pair_id, amount_id, mode
    )
    SELECT
      ? || '|' || p.pair_id || '|' || p.amount_id || '|' || p.mode,
      ?, p.pair_id, p.amount_id, p.mode,
      json_object('p', json(p.protocols_json), 'w', json(COALESCE(w.wins_json, '{}'))),
      p.latest_at
    FROM protocol_payloads p
    LEFT JOIN win_payloads w
      ON w.pair_id = p.pair_id AND w.amount_id = p.amount_id AND w.mode = p.mode
  `).bind(start, end, day, day);
  await d1.batch([removeExisting, insertCompact]);
}

async function deleteInBatches(d1: D1Database, sql: string, values: unknown[] = []) {
  let deleted = 0;
  for (let batch = 0; batch < deleteBatchesPerMaintenance; batch += 1) {
    const result = await d1.prepare(sql).bind(...values).run();
    const changes = Number(result.meta.changes ?? 0);
    deleted += changes;
    if (changes < deleteBatchSize) break;
  }
  return deleted;
}

async function pruneDetailedHistory(cutoff: string, d1: D1Database) {
  const latestPayloads = await deleteInBatches(d1, `
    DELETE FROM latest_quote_payloads WHERE id IN (
      SELECT p.id FROM latest_quote_payloads p
      JOIN benchmark_runs r ON r.id = p.run_id
      WHERE r.mode = 'standard' OR r.initiated_at < ?
      LIMIT ${deleteBatchSize}
    )
  `, [cutoff]);
  const protocolQuotes = await deleteInBatches(d1, `
    DELETE FROM protocol_quotes WHERE id IN (
      SELECT q.id FROM protocol_quotes q
      JOIN benchmark_runs r ON r.id = q.run_id
      WHERE r.mode = 'standard' OR r.initiated_at < ?
      LIMIT ${deleteBatchSize}
    )
  `, [cutoff]);
  const benchmarkRuns = await deleteInBatches(d1, `
    DELETE FROM benchmark_runs WHERE id IN (
      SELECT r.id FROM benchmark_runs r
      WHERE (r.mode = 'standard' OR r.initiated_at < ?)
        AND NOT EXISTS (SELECT 1 FROM protocol_quotes q WHERE q.run_id = r.id)
      LIMIT ${deleteBatchSize}
    )
  `, [cutoff]);
  return { latestPayloads, protocolQuotes, benchmarkRuns };
}

async function pruneTrendHistory(hourlyCutoff: string, fourHourCutoff: string, d1: D1Database) {
  return deleteInBatches(d1, `
    DELETE FROM trend_buckets WHERE id IN (
      SELECT id FROM trend_buckets
      WHERE mode = 'standard'
        OR (bucket_seconds = ? AND bucket_start < ?)
        OR (bucket_seconds = ? AND bucket_start < ?)
      LIMIT ${deleteBatchSize}
    )
  `, [hourlyTrendBucketSeconds, hourlyCutoff, fourHourTrendBucketSeconds, fourHourCutoff]);
}

export async function runDailyMaintenance(scheduledTime: number, environment: CollectorEnvironment) {
  await ensureBenchmarkSchema();
  const d1 = environment.DB;
  const yesterday = new Date(scheduledTime - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  await aggregateDay(yesterday, d1);
  const trendStart = `${yesterday}T00:00:00.000Z`;
  const trendEnd = new Date(new Date(trendStart).getTime() + 24 * 60 * 60 * 1000).toISOString();
  await refreshTrendBucketRange(trendStart, trendEnd, hourlyTrendBucketSeconds, d1);
  await refreshTrendBucketRange(trendStart, trendEnd, fourHourTrendBucketSeconds, d1);
  const detailCutoff = new Date(scheduledTime - detailRetentionDays * 24 * 60 * 60 * 1000).toISOString();
  const aggregateCutoff = new Date(scheduledTime - aggregateRetentionDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const hourlyTrendCutoff = new Date(scheduledTime - hourlyTrendRetentionDays * 24 * 60 * 60 * 1000).toISOString();
  const fourHourTrendCutoff = new Date(scheduledTime - fourHourTrendRetentionDays * 24 * 60 * 60 * 1000).toISOString();
  const detailedHistory = await pruneDetailedHistory(detailCutoff, d1);
  const trendBuckets = await pruneTrendHistory(hourlyTrendCutoff, fourHourTrendCutoff, d1);
  await d1.prepare("DELETE FROM collector_bundles WHERE sweep_id IN (SELECT id FROM collector_sweeps WHERE scheduled_for < ?)").bind(detailCutoff).run();
  await d1.prepare("DELETE FROM collector_sweeps WHERE scheduled_for < ?").bind(detailCutoff).run();
  await d1.prepare("DELETE FROM daily_comparison_metrics WHERE day < ?").bind(aggregateCutoff).run();
  await d1.prepare("PRAGMA optimize").run();
  return {
    aggregatedDay: yesterday,
    detailCutoff,
    aggregateCutoff,
    hourlyTrendCutoff,
    fourHourTrendCutoff,
    deleted: { detailedHistory, trendBuckets },
  };
}
