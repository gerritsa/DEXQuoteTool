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
  requestJson: text("request_json"),
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
  uniqueIndex("idx_benchmark_runs_sweep_job").on(table.sweepId, table.pairId, table.amountId, table.mode),
]);

export const protocolQuotes = sqliteTable("protocol_quotes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  runId: integer("run_id").notNull().references(() => benchmarkRuns.id),
  protocol: text("protocol", { enum: ["thorchain", "chainflip", "near-intents", "maya"] }).notNull(),
  strategy: text("strategy", { enum: ["single", "streaming", "regular", "dca", "solver"] }).notNull(),
  status: text("status", { enum: ["quoted", "unavailable", "error"] }).notNull(),
  expectedOutputBaseUnits: text("expected_output_base_units"),
  expectedOutputFormatted: text("expected_output_formatted"),
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
]);

export const dailyComparisonMetrics = sqliteTable("daily_comparison_metrics", {
  id: text("id").primaryKey(),
  day: text("day").notNull(),
  pairId: text("pair_id").notNull(),
  amountId: text("amount_id").notNull(),
  mode: text("mode", { enum: ["standard", "optimized"] }).notNull(),
  protocolMask: text("protocol_mask").notNull(),
  protocol: text("protocol", { enum: ["thorchain", "chainflip", "near-intents", "maya"] }).notNull(),
  attempts: integer("attempts").notNull(),
  successes: integer("successes").notNull(),
  comparableSamples: integer("comparable_samples").notNull(),
  edgeSumBps: real("edge_sum_bps").notNull().default(0),
  wins: real("wins").notNull(),
  latestAt: text("latest_at").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_daily_metrics_lookup").on(table.pairId, table.amountId, table.mode, table.day),
  index("idx_daily_metrics_day_mask").on(table.day, table.protocolMask),
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
