import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const benchmarkCycles = sqliteTable("benchmark_cycles", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  scope: text("scope").notNull().default("thorchain_top_20"),
  rankingWindow: text("ranking_window").notNull().default("24h_pool_activity"),
  status: text("status", { enum: ["pending", "running", "complete", "partial", "failed"] }).notNull().default("pending"),
  routeCount: integer("route_count").notNull().default(20),
  requestCount: integer("request_count").notNull().default(0),
  successfulQuoteCount: integer("successful_quote_count").notNull().default(0),
  startedAt: text("started_at").notNull(),
  completedAt: text("completed_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_benchmark_cycles_created").on(table.createdAt),
]);

export const benchmarkRuns = sqliteTable("benchmark_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  cycleId: integer("cycle_id").references(() => benchmarkCycles.id),
  pairId: text("pair_id").notNull(),
  rangeId: text("range_id").notNull().default("unassigned"),
  samplePoint: text("sample_point", { enum: ["scheduled_midpoint", "low", "midpoint", "high", "crossover"] }).notNull().default("scheduled_midpoint"),
  sourceAsset: text("source_asset").notNull(),
  destinationAsset: text("destination_asset").notNull(),
  sourceAmountBaseUnits: text("source_amount_base_units").notNull(),
  sourceAmountUsd: real("source_amount_usd").notNull(),
  sourcePriceUsd: real("source_price_usd").notNull(),
  mode: text("mode", { enum: ["standard", "optimized"] }).notNull(),
  status: text("status", { enum: ["pending", "complete", "partial", "failed"] }).notNull().default("pending"),
  initiatedAt: text("initiated_at").notNull(),
  completedAt: text("completed_at"),
  maxRequestSkewMs: integer("max_request_skew_ms"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_benchmark_runs_pair_created").on(table.pairId, table.createdAt),
  index("idx_benchmark_runs_pair_range_created").on(table.pairId, table.rangeId, table.createdAt),
  index("idx_benchmark_runs_cycle").on(table.cycleId),
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
  rawResponseJson: text("raw_response_json"),
  requestUrl: text("request_url"),
  requestPayloadJson: text("request_payload_json"),
  responseHttpStatus: integer("response_http_status"),
  responseLatencyMs: integer("response_latency_ms"),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_protocol_quotes_run_protocol").on(table.runId, table.protocol),
]);
