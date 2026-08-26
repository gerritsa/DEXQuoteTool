import { ensureBenchmarkSchema } from "../db";
import { benchmarkCatalogGraceMs, fixedThorRouteCount, getCatalog, resolveFixedThorRoutes } from "./routes/catalog";
import { quoteSizes } from "./quotes/sizes";
import { runSelectedBenchmark, type BenchmarkArchiveRecord } from "./quotes/run";
import type { ExecutionMode, NormalizedQuote, ProtocolId } from "./quotes/types";

const modes: ExecutionMode[] = ["standard", "optimized"];
const protocols: ProtocolId[] = ["thorchain", "chainflip", "near-intents"];
const jobsPerMessage = 20;
const workerConcurrency = 1;
const detailRetentionDays = 90;
const aggregateRetentionDays = 400;
const hourlyTrendBucketSeconds = 60 * 60;
const fourHourTrendBucketSeconds = 4 * hourlyTrendBucketSeconds;
const hourlyTrendRetentionDays = 8;
const fourHourTrendRetentionDays = 32;

export type CollectorJob = { routeId: string; amountId: string; mode: ExecutionMode };
export type CollectorBundle = { sweepId: string; scheduledFor: string; bundleIndex: number; jobs: CollectorJob[] };

export type CollectorEnvironment = {
  DB: D1Database;
  ARCHIVE: R2Bucket;
  BENCHMARK_QUEUE: Queue<CollectorBundle>;
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
  const { routes, missingRouteIds } = resolveFixedThorRoutes(catalog.assets, fixedThorRouteCount);
  const jobs = routes.flatMap((route) => quoteSizes.flatMap((size) => modes.map((mode) => ({ routeId: route.id, amountId: size.id, mode }))));
  const bundles = chunks(jobs, jobsPerMessage).map((bundleJobs, bundleIndex): CollectorBundle => ({ sweepId, scheduledFor, bundleIndex, jobs: bundleJobs }));
  const now = new Date().toISOString();

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
  `).bind(sweepId, sweepId, sweepId, sweepId, sweepId, fixedThorRouteCount, sweepId, now, sweepId).run();
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
            'output', CAST(q.expected_output_formatted AS REAL)
          ))
          FROM protocol_quotes q
          WHERE q.run_id = bucketed_runs.id
            AND q.status = 'quoted'
            AND CAST(q.expected_output_formatted AS REAL) > 0
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
        const result = await runSelectedBenchmark(job.routeId, job.amountId, job.mode, { sweepId: bundle.sweepId, bundleIndex: bundle.bundleIndex });
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
  return masks;
}

async function aggregateDay(day: string, d1: D1Database) {
  const start = `${day}T00:00:00.000Z`;
  const end = new Date(new Date(start).getTime() + 24 * 60 * 60 * 1000).toISOString();
  for (const selected of protocolMasks()) {
    const protocolMask = selected.join(",");
    const quotedProtocols = selected.map((protocol) => `'${protocol}'`).join(", ");
    await d1.prepare("DELETE FROM daily_comparison_metrics WHERE day = ? AND protocol_mask = ?").bind(day, protocolMask).run();
    await d1.prepare(`
      INSERT INTO daily_comparison_metrics (
        id, day, pair_id, amount_id, mode, protocol_mask, protocol,
        attempts, successes, comparable_samples, edge_sum_bps, wins, latest_at
      )
      WITH attempts AS (
        SELECT r.id AS run_id, r.pair_id, r.amount_id, r.mode, r.initiated_at,
          q.protocol, q.status, CAST(q.expected_output_formatted AS REAL) AS output
        FROM benchmark_runs r
        JOIN protocol_quotes q ON q.run_id = r.id
        WHERE r.initiated_at >= ? AND r.initiated_at < ?
          AND r.completed_at IS NOT NULL AND r.status IN ('complete', 'partial')
          AND q.protocol IN (${quotedProtocols})
      ), valid AS (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY run_id ORDER BY output) AS output_rank,
          COUNT(*) OVER (PARTITION BY run_id) AS valid_count,
          MAX(output) OVER (PARTITION BY run_id) AS best_output
        FROM attempts
        WHERE status = 'quoted' AND output > 0
      ), run_stats AS (
        SELECT run_id, MAX(valid_count) AS valid_count, MAX(best_output) AS best_output,
          SUM(CASE WHEN output = best_output THEN 1 ELSE 0 END) AS winner_count
        FROM valid
        GROUP BY run_id
      ), medians AS (
        SELECT run_id, AVG(output) AS median_output
        FROM valid
        WHERE output_rank = CAST((valid_count + 1) / 2 AS INTEGER)
           OR output_rank = CAST((valid_count + 2) / 2 AS INTEGER)
        GROUP BY run_id
      ), scored AS (
        SELECT attempts.*, medians.median_output, run_stats.valid_count, run_stats.best_output, run_stats.winner_count
        FROM attempts
        LEFT JOIN medians ON medians.run_id = attempts.run_id
        LEFT JOIN run_stats ON run_stats.run_id = attempts.run_id
      )
      SELECT
        ? || '|' || pair_id || '|' || amount_id || '|' || mode || '|' || ? || '|' || protocol,
        ?, pair_id, amount_id, mode, ?, protocol,
        COUNT(*),
        SUM(CASE WHEN status = 'quoted' THEN 1 ELSE 0 END),
        SUM(CASE WHEN status = 'quoted' AND valid_count >= 2 THEN 1 ELSE 0 END),
        SUM(CASE WHEN status = 'quoted' AND valid_count >= 2 THEN ((output / median_output) - 1) * 10000 ELSE 0 END),
        SUM(CASE WHEN status = 'quoted' AND valid_count >= 2 AND output = best_output THEN 1.0 / winner_count ELSE 0 END),
        MAX(initiated_at)
      FROM scored
      GROUP BY pair_id, amount_id, mode, protocol
    `).bind(start, end, day, protocolMask, day, protocolMask).run();
  }
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
  await d1.prepare("DELETE FROM latest_quote_payloads WHERE run_id IN (SELECT id FROM benchmark_runs WHERE initiated_at < ?)").bind(detailCutoff).run();
  await d1.prepare("DELETE FROM protocol_quotes WHERE run_id IN (SELECT id FROM benchmark_runs WHERE initiated_at < ?)").bind(detailCutoff).run();
  await d1.prepare("DELETE FROM benchmark_runs WHERE initiated_at < ?").bind(detailCutoff).run();
  await d1.prepare("DELETE FROM collector_bundles WHERE sweep_id IN (SELECT id FROM collector_sweeps WHERE scheduled_for < ?)").bind(detailCutoff).run();
  await d1.prepare("DELETE FROM collector_sweeps WHERE scheduled_for < ?").bind(detailCutoff).run();
  await d1.prepare("DELETE FROM daily_comparison_metrics WHERE day < ?").bind(aggregateCutoff).run();
  await d1.prepare("DELETE FROM trend_buckets WHERE bucket_seconds = ? AND bucket_start < ?").bind(hourlyTrendBucketSeconds, hourlyTrendCutoff).run();
  await d1.prepare("DELETE FROM trend_buckets WHERE bucket_seconds = ? AND bucket_start < ?").bind(fourHourTrendBucketSeconds, fourHourTrendCutoff).run();
  await d1.prepare("PRAGMA optimize").run();
  return { aggregatedDay: yesterday, detailCutoff, aggregateCutoff, hourlyTrendCutoff, fourHourTrendCutoff };
}
