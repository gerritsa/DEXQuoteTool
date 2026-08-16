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
      d1.prepare(`CREATE TABLE IF NOT EXISTS benchmark_cycles (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        scope TEXT DEFAULT 'thorchain_top_20' NOT NULL,
        ranking_window TEXT DEFAULT '24h_pool_activity' NOT NULL,
        status TEXT DEFAULT 'pending' NOT NULL,
        route_count INTEGER DEFAULT 20 NOT NULL,
        request_count INTEGER DEFAULT 0 NOT NULL,
        successful_quote_count INTEGER DEFAULT 0 NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
      )`),
      d1.prepare(`CREATE TABLE IF NOT EXISTS benchmark_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        cycle_id INTEGER REFERENCES benchmark_cycles(id),
        pair_id TEXT NOT NULL,
        range_id TEXT DEFAULT 'unassigned' NOT NULL,
        sample_point TEXT DEFAULT 'scheduled_midpoint' NOT NULL,
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
        raw_response_json TEXT,
        request_url TEXT,
        request_payload_json TEXT,
        response_http_status INTEGER,
        response_latency_ms INTEGER,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
      )`),
    ]);

    const requiredColumns: Record<string, Array<[string, string]>> = {
      benchmark_runs: [
        ["cycle_id", "INTEGER REFERENCES benchmark_cycles(id)"],
        ["range_id", "TEXT DEFAULT 'unassigned' NOT NULL"],
        ["sample_point", "TEXT DEFAULT 'scheduled_midpoint' NOT NULL"],
      ],
      protocol_quotes: [
        ["request_url", "TEXT"],
        ["request_payload_json", "TEXT"],
        ["response_http_status", "INTEGER"],
        ["response_latency_ms", "INTEGER"],
      ],
    };

    for (const [table, columns] of Object.entries(requiredColumns)) {
      const info = await d1.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
      const existing = new Set(info.results.map((column) => column.name));
      for (const [name, definition] of columns) {
        if (!existing.has(name)) await d1.prepare(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`).run();
      }
    }

    await d1.batch([
      d1.prepare("CREATE INDEX IF NOT EXISTS idx_benchmark_cycles_created ON benchmark_cycles(created_at)"),
      d1.prepare("CREATE INDEX IF NOT EXISTS idx_benchmark_runs_pair_created ON benchmark_runs(pair_id, created_at)"),
      d1.prepare("CREATE INDEX IF NOT EXISTS idx_benchmark_runs_pair_range_created ON benchmark_runs(pair_id, range_id, created_at)"),
      d1.prepare("CREATE INDEX IF NOT EXISTS idx_benchmark_runs_cycle ON benchmark_runs(cycle_id)"),
      d1.prepare("CREATE INDEX IF NOT EXISTS idx_protocol_quotes_run_protocol ON protocol_quotes(run_id, protocol)"),
    ]);
  })();
  return schemaReady;
}
