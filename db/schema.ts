import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const benchmarkRuns = sqliteTable("benchmark_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  pairId: text("pair_id").notNull(),
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
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("idx_protocol_quotes_run_protocol").on(table.runId, table.protocol),
]);
