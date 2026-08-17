import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export function getDb() {
  if (!env.DB) {
    throw new Error(
      "Cloudflare D1 binding `DB` is unavailable. Set the `d1` field in .openai/hosting.json to `DB` or let your control plane inject the real binding values before using the database."
    );
  }

  return drizzle(env.DB, { schema });
}

export function getD1() {
  if (!env.DB) throw new Error("Cloudflare D1 binding `DB` is unavailable.");
  return env.DB;
}

let schemaReady: Promise<void> | undefined;

export function ensureBenchmarkSchema() {
  schemaReady ??= (async () => {
    const d1 = getD1();
    await d1.batch([
      d1.prepare(`CREATE TABLE IF NOT EXISTS benchmark_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        pair_id TEXT NOT NULL,
        amount_id TEXT NOT NULL,
        source_asset TEXT NOT NULL,
        destination_asset TEXT NOT NULL,
        source_amount_base_units TEXT NOT NULL,
        source_amount_usd REAL NOT NULL,
        source_price_usd REAL NOT NULL,
        mode TEXT NOT NULL,
        status TEXT DEFAULT 'pending' NOT NULL,
        initiated_at TEXT NOT NULL,
        completed_at TEXT,
        max_request_skew_ms INTEGER,
        sweep_id TEXT,
        bundle_index INTEGER,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
      )`),
      d1.prepare(`CREATE TABLE IF NOT EXISTS protocol_quotes (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        run_id INTEGER NOT NULL REFERENCES benchmark_runs(id),
        protocol TEXT NOT NULL,
        strategy TEXT NOT NULL,
        status TEXT NOT NULL,
        expected_output_base_units TEXT,
        expected_output_formatted TEXT,
        quoted_fee_usd REAL,
        estimated_duration_seconds INTEGER,
        request_started_at TEXT NOT NULL,
        response_received_at TEXT,
        quote_expires_at TEXT,
        request_url TEXT,
        response_http_status INTEGER,
        response_latency_ms INTEGER,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
      )`),
      d1.prepare(`CREATE TABLE IF NOT EXISTS collector_sweeps (
        id TEXT PRIMARY KEY NOT NULL,
        scheduled_for TEXT NOT NULL,
        status TEXT DEFAULT 'pending' NOT NULL,
        route_count INTEGER NOT NULL,
        job_count INTEGER NOT NULL,
        bundle_count INTEGER NOT NULL,
        completed_jobs INTEGER DEFAULT 0 NOT NULL,
        failed_jobs INTEGER DEFAULT 0 NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
      )`),
      d1.prepare(`CREATE TABLE IF NOT EXISTS collector_bundles (
        id TEXT PRIMARY KEY NOT NULL,
        sweep_id TEXT NOT NULL REFERENCES collector_sweeps(id),
        bundle_index INTEGER NOT NULL,
        status TEXT DEFAULT 'pending' NOT NULL,
        job_count INTEGER NOT NULL,
        completed_jobs INTEGER DEFAULT 0 NOT NULL,
        failed_jobs INTEGER DEFAULT 0 NOT NULL,
        attempts INTEGER DEFAULT 0 NOT NULL,
        normalized_archive_key TEXT,
        raw_archive_key TEXT,
        started_at TEXT,
        completed_at TEXT,
        error_message TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
      )`),
      d1.prepare(`CREATE TABLE IF NOT EXISTS latest_quote_payloads (
        id TEXT PRIMARY KEY NOT NULL,
        run_id INTEGER NOT NULL REFERENCES benchmark_runs(id),
        pair_id TEXT NOT NULL,
        amount_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        protocol TEXT NOT NULL,
        request_url TEXT,
        request_payload_json TEXT,
        raw_response_json TEXT,
        error_message TEXT,
        updated_at TEXT NOT NULL
      )`),
      d1.prepare(`CREATE TABLE IF NOT EXISTS daily_comparison_metrics (
        id TEXT PRIMARY KEY NOT NULL,
        day TEXT NOT NULL,
        pair_id TEXT NOT NULL,
        amount_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        protocol_mask TEXT NOT NULL,
        protocol TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        successes INTEGER NOT NULL,
        comparable_samples INTEGER NOT NULL,
        edge_sum_bps REAL DEFAULT 0 NOT NULL,
        wins REAL NOT NULL,
        latest_at TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
      )`),
    ]);

    await d1.batch([
      d1.prepare("CREATE INDEX IF NOT EXISTS idx_benchmark_runs_pair_created ON benchmark_runs(pair_id, created_at)"),
      d1.prepare("CREATE INDEX IF NOT EXISTS idx_benchmark_runs_pair_amount_created ON benchmark_runs(pair_id, amount_id, created_at)"),
      d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_benchmark_runs_sweep_job ON benchmark_runs(sweep_id, pair_id, amount_id, mode)"),
      d1.prepare("CREATE INDEX IF NOT EXISTS idx_protocol_quotes_run_protocol ON protocol_quotes(run_id, protocol)"),
      d1.prepare("CREATE INDEX IF NOT EXISTS idx_collector_sweeps_scheduled ON collector_sweeps(scheduled_for)"),
      d1.prepare("CREATE INDEX IF NOT EXISTS idx_collector_bundles_sweep ON collector_bundles(sweep_id, bundle_index)"),
      d1.prepare("CREATE INDEX IF NOT EXISTS idx_latest_quote_payloads_lookup ON latest_quote_payloads(pair_id, amount_id, mode)"),
      d1.prepare("CREATE INDEX IF NOT EXISTS idx_daily_metrics_lookup ON daily_comparison_metrics(pair_id, amount_id, mode, day)"),
      d1.prepare("CREATE INDEX IF NOT EXISTS idx_daily_metrics_day_mask ON daily_comparison_metrics(day, protocol_mask)"),
      d1.prepare("PRAGMA optimize"),
    ]);
  })();
  return schemaReady;
}
