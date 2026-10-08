import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const benchmarkRuns = sqliteTable("benchmark_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  pairId: text("pair_id").notNull(),
  amountId: text("amount_id").notNull(),
  sourceAsset: text("source_asset").notNull(),
  destinationAsset: text("destination_asset").notNull(),
  sourceAmountBaseUnits: text("source_amount_base_units").notNull(),
  sourceAmountUsd: real("source_amount_usd").notNull(),
  sourcePriceUsd: real("source_price_usd").notNull(),
  oracleSourcePriceUsd: real("oracle_source_price_usd"),
  oracleDestinationPriceUsd: real("oracle_destination_price_usd"),
  oracleReferenceOutput: real("oracle_reference_output"),
  oracleCapturedAt: text("oracle_captured_at"),
  requestJson: text("request_json"),
  depthForecastJson: text("depth_forecast_json"),
  mode: text("mode", { enum: ["standard", "optimized"] }).notNull(),
  status: text("status", { enum: ["pending", "complete", "partial", "failed"] }).notNull().default("pending"),
  initiatedAt: text("initiated_at").notNull(),
  completedAt: text("completed_at"),
  maxRequestSkewMs: integer("max_request_skew_ms"),
  sweepId: text("sweep_id"),
  bundleIndex: integer("bundle_index"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_benchmark_runs_pair_created").on(table.pairId, table.createdAt),
  index("idx_benchmark_runs_pair_amount_created").on(table.pairId, table.amountId, table.createdAt),
  index("idx_benchmark_runs_initiated").on(table.initiatedAt),
  index("idx_benchmark_runs_mode_initiated").on(table.mode, table.initiatedAt),
  uniqueIndex("idx_benchmark_runs_sweep_job").on(table.sweepId, table.pairId, table.amountId, table.mode),
]);

export const poolDepthSnapshots = sqliteTable("pool_depth_snapshots", {
  id: text("id").primaryKey(),
  capturedAt: text("captured_at").notNull(),
  poolsJson: text("pools_json").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_pool_depth_snapshots_captured").on(table.capturedAt),
]);

export const protocolQuotes = sqliteTable("protocol_quotes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  runId: integer("run_id").notNull().references(() => benchmarkRuns.id),
  protocol: text("protocol", { enum: ["thorchain", "chainflip", "near-intents", "maya"] }).notNull(),
  strategy: text("strategy", { enum: ["single", "streaming", "regular", "dca", "solver"] }).notNull(),
  status: text("status", { enum: ["quoted", "unavailable", "error"] }).notNull(),
  expectedOutputBaseUnits: text("expected_output_base_units"),
  expectedOutputFormatted: text("expected_output_formatted"),
  oracleGapBps: real("oracle_gap_bps"),
  quotedFeeUsd: real("quoted_fee_usd"),
  estimatedDurationSeconds: integer("estimated_duration_seconds"),
  requestStartedAt: text("request_started_at").notNull(),
  responseReceivedAt: text("response_received_at"),
  quoteExpiresAt: text("quote_expires_at"),
  requestUrl: text("request_url"),
  responseHttpStatus: integer("response_http_status"),
  responseLatencyMs: integer("response_latency_ms"),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_protocol_quotes_run_protocol").on(table.runId, table.protocol),
]);

export const collectorSweeps = sqliteTable("collector_sweeps", {
  id: text("id").primaryKey(),
  scheduledFor: text("scheduled_for").notNull(),
  status: text("status", { enum: ["pending", "running", "complete", "partial", "failed"] }).notNull().default("pending"),
  routeCount: integer("route_count").notNull(),
  jobCount: integer("job_count").notNull(),
  bundleCount: integer("bundle_count").notNull(),
  completedJobs: integer("completed_jobs").notNull().default(0),
  failedJobs: integer("failed_jobs").notNull().default(0),
  startedAt: text("started_at").notNull(),
  completedAt: text("completed_at"),
  missingRoutesJson: text("missing_routes_json"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_collector_sweeps_scheduled").on(table.scheduledFor),
]);

export const collectorBundles = sqliteTable("collector_bundles", {
  id: text("id").primaryKey(),
  sweepId: text("sweep_id").notNull().references(() => collectorSweeps.id),
  bundleIndex: integer("bundle_index").notNull(),
  status: text("status", { enum: ["pending", "running", "complete", "partial", "failed"] }).notNull().default("pending"),
  jobCount: integer("job_count").notNull(),
  completedJobs: integer("completed_jobs").notNull().default(0),
  failedJobs: integer("failed_jobs").notNull().default(0),
  attempts: integer("attempts").notNull().default(0),
  normalizedArchiveKey: text("normalized_archive_key"),
  rawArchiveKey: text("raw_archive_key"),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
  errorMessage: text("error_message"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_collector_bundles_sweep").on(table.sweepId, table.bundleIndex),
]);

export const latestQuotePayloads = sqliteTable("latest_quote_payloads", {
  id: text("id").primaryKey(),
  runId: integer("run_id").notNull().references(() => benchmarkRuns.id),
  pairId: text("pair_id").notNull(),
  amountId: text("amount_id").notNull(),
  mode: text("mode", { enum: ["standard", "optimized"] }).notNull(),
  protocol: text("protocol", { enum: ["thorchain", "chainflip", "near-intents", "maya"] }).notNull(),
  requestUrl: text("request_url"),
  requestPayloadJson: text("request_payload_json"),
  rawResponseJson: text("raw_response_json"),
  errorMessage: text("error_message"),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  index("idx_latest_quote_payloads_lookup").on(table.pairId, table.amountId, table.mode),
  index("idx_latest_quote_payloads_revision").on(table.mode, table.runId, table.updatedAt),
]);

export const dailyComparisonMetrics = sqliteTable("daily_comparison_metrics", {
  id: text("id").primaryKey(),
  day: text("day").notNull(),
  pairId: text("pair_id").notNull(),
  amountId: text("amount_id").notNull(),
  mode: text("mode", { enum: ["standard", "optimized"] }).notNull(),
  metricsJson: text("metrics_json").notNull(),
  latestAt: text("latest_at").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_daily_metrics_lookup").on(table.pairId, table.amountId, table.mode, table.day),
  index("idx_daily_metrics_window").on(table.mode, table.day),
]);

export const trendBuckets = sqliteTable("trend_buckets", {
  id: text("id").primaryKey(),
  bucketStart: text("bucket_start").notNull(),
  bucketSeconds: integer("bucket_seconds").notNull(),
  pairId: text("pair_id").notNull(),
  amountId: text("amount_id").notNull(),
  mode: text("mode", { enum: ["standard", "optimized"] }).notNull(),
  samplesJson: text("samples_json").notNull(),
  latestAt: text("latest_at").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_trend_buckets_lookup").on(table.pairId, table.amountId, table.mode, table.bucketSeconds, table.bucketStart),
  index("idx_trend_buckets_retention").on(table.bucketSeconds, table.bucketStart),
]);

export const catalogState = sqliteTable("catalog_state", {
  id: text("id").primaryKey(),
  assetsJson: text("assets_json"),
  refreshedAt: text("refreshed_at"),
  lastAttemptAt: text("last_attempt_at").notNull(),
  lastError: text("last_error"),
});

export const catalogSources = sqliteTable("catalog_sources", {
  source: text("source", { enum: ["thorchain", "maya", "near-intents", "chainflip"] }).primaryKey(),
  payloadJson: text("payload_json"),
  refreshedAt: text("refreshed_at"),
  lastAttemptAt: text("last_attempt_at").notNull(),
  lastError: text("last_error"),
});

export const volumeRoutes = sqliteTable("volume_routes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  routeId: text("route_id").notNull().unique(),
});
export const volumeHourly = sqliteTable("volume_hourly", {
  id: text("id").primaryKey(), routeKey: integer("route_key").notNull(),
  protocol: text("protocol").notNull(), hour: integer("hour").notNull(),
  totalsJson: text("totals_json").notNull(), updatedAt: text("updated_at").notNull(),
}, (table) => [index("idx_volume_hourly_route_hour").on(table.routeKey, table.hour), index("idx_volume_hourly_expiry").on(table.hour)]);
export const volumeFeedHours = sqliteTable("volume_feed_hours", {
  id: text("id").primaryKey(), protocol: text("protocol").notNull(), hour: integer("hour").notNull(),
  status: text("status").notNull().default("pending"), generation: integer("generation").notNull().default(0),
  cursor: text("cursor"), pages: integer("pages").notNull().default(0), records: integer("records").notNull().default(0),
  pending: integer("pending").notNull().default(0), nextAttempt: integer("next_attempt").notNull().default(0),
  stagedRows: integer("staged_rows").notNull().default(0),
  failures: integer("failures").notNull().default(0), lastError: text("last_error"), updatedAt: text("updated_at"),
}, (table) => [index("idx_volume_feed_work").on(table.protocol, table.status, table.nextAttempt, table.hour), index("idx_volume_feed_expiry").on(table.hour)]);
export const volumeIngestionState = sqliteTable("volume_ingestion_state", {
  protocol: text("protocol").primaryKey(), lease: text("lease"), leaseUntil: integer("lease_until").notNull().default(0),
  nextRequest: integer("next_request").notNull().default(0), lastError: text("last_error"), updatedAt: text("updated_at"),
  budgetDay: integer("budget_day").notNull().default(0), pagesToday: integer("pages_today").notNull().default(0),
  backgroundPagesToday: integer("background_pages_today").notNull().default(0),
});
export const volumeRecentSwaps = sqliteTable("volume_recent_swaps", {
  id: text("id").primaryKey(), jobId: text("job_id").notNull(), generation: integer("generation").notNull(),
  routeKey: integer("route_key").notNull(), usdMicros: text("usd_micros"), pending: integer("pending").notNull(),
  createdAt: integer("created_at").notNull(),
}, (table) => [index("idx_volume_recent_job").on(table.jobId, table.generation), index("idx_volume_recent_expiry").on(table.createdAt)]);
export const routeQuoteHourly = sqliteTable("route_quote_hourly", {
  id: text("id").primaryKey(), routeKey: integer("route_key").notNull(), hour: integer("hour").notNull(),
  scoresJson: text("scores_json").notNull(), updatedAt: text("updated_at").notNull(),
}, (table) => [index("idx_route_quote_hourly_lookup").on(table.routeKey, table.hour), index("idx_route_quote_hourly_expiry").on(table.hour)]);
export const routeVolumeWindows = sqliteTable("route_volume_windows", {
  id: text("id").primaryKey(), routeKey: integer("route_key").notNull(), days: integer("days").notNull(),
  payloadJson: text("payload_json").notNull(), revision: text("revision").notNull(), updatedAt: text("updated_at").notNull(),
});
