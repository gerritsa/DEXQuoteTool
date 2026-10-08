import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { registerHooks } from "node:module";
import test from "node:test";

globalThis.__trendTestEnv = {};
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "cloudflare:workers") return { url: "data:text/javascript,export const env = globalThis.__trendTestEnv;", shortCircuit: true };
  try { return nextResolve(specifier, context); }
  catch (error) {
    if (specifier.startsWith(".") && !/\.[a-z]+$/.test(specifier)) {
      try { return nextResolve(`${specifier}.ts`, context); }
      catch { return nextResolve(`${specifier}/index.ts`, context); }
    }
    throw error;
  }
} });
const { GET } = await import("../app/api/trends/route.ts");
const { GET: comparisonGET } = await import("../app/api/comparison/route.ts");
const { GET: runsGET } = await import("../app/api/runs/route.ts");
const { getTableConfig } = await import("drizzle-orm/sqlite-core");
const schema = await import("../db/schema.ts");
const { canonicalPublicCacheUrl } = await import("../lib/http-cache.ts");
const routeId = "bitcoin:native:btc__ethereum:native:eth";
const oldAt = "2026-10-08T16:02:00.000Z";
const latestAt = "2026-10-08T16:32:00.000Z";
const oldQuotes = [{ protocol: "thorchain", output: 205, oracleGapBps: -29 }, { protocol: "chainflip", output: 205.1, oracleGapBps: -23 }];
const latestQuotes = [{ protocol: "thorchain", output: 205.90283086, oracleGapBps: -13.52326293 }, { protocol: "chainflip", output: 205.80239533, oracleGapBps: -18.39447844 }];

function fixture(t) {
  const previousNow = Date.now;
  Date.now = () => Date.parse("2026-10-08T16:37:00.000Z");
  const database = new DatabaseSync(":memory:");
  database.exec(`CREATE TABLE benchmark_runs (
    id INTEGER PRIMARY KEY, pair_id TEXT, amount_id TEXT, mode TEXT, initiated_at TEXT,
    created_at TEXT, oracle_captured_at TEXT, completed_at TEXT, status TEXT, sweep_id TEXT
  );
  CREATE INDEX idx_benchmark_runs_pair_amount_created ON benchmark_runs(pair_id, amount_id, created_at);
  CREATE TABLE protocol_quotes(run_id INTEGER, protocol TEXT, status TEXT, expected_output_formatted TEXT, oracle_gap_bps REAL);
  CREATE INDEX idx_protocol_quotes_run_protocol ON protocol_quotes(run_id, protocol);
  CREATE TABLE latest_quote_payloads(run_id INTEGER, pair_id TEXT, amount_id TEXT, mode TEXT, updated_at TEXT);
  CREATE INDEX idx_latest_quote_payloads_lookup ON latest_quote_payloads(pair_id, amount_id, mode);
  CREATE INDEX idx_latest_quote_payloads_revision ON latest_quote_payloads(mode, run_id, updated_at);
  CREATE TABLE trend_buckets(pair_id TEXT, amount_id TEXT, mode TEXT, bucket_seconds INTEGER, bucket_start TEXT, samples_json TEXT);
  CREATE TABLE daily_comparison_metrics(pair_id TEXT, amount_id TEXT, mode TEXT, day TEXT, metrics_json TEXT);
  CREATE TABLE collector_sweeps(id TEXT, status TEXT);
  CREATE TABLE collector_bundles(sweep_id TEXT, bundle_index INTEGER, raw_archive_key TEXT);
  INSERT INTO collector_sweeps VALUES('unfinished-sweep', 'running');`);
  // Supply the remaining mapped columns so the actual D1/Drizzle run handler
  // can participate in the same API integration tests.
  for (const table of [schema.benchmarkRuns, schema.protocolQuotes, schema.latestQuotePayloads]) {
    const config = getTableConfig(table);
    const existing = new Set(database.prepare(`PRAGMA table_info(${config.name})`).all().map((c) => c.name));
    for (const column of config.columns) if (!existing.has(column.name)) database.exec(`ALTER TABLE ${config.name} ADD COLUMN ${column.name} ${column.getSQLType()}`);
  }
  const queries = [];
  globalThis.__trendTestEnv.DB = { prepare(sql) {
    const statement = database.prepare(sql);
    let args = [];
    const prepared = {
      bind(...values) { args = values; return prepared; },
      async all() { queries.push(sql); return { results: statement.all(...args) }; },
      async first() { queries.push(sql); return statement.get(...args) ?? null; },
      async raw() { queries.push(sql); return statement.all(...args).map((row) => Object.values(row)); },
    };
    return prepared;
  } };
  const cache = new Map();
  globalThis.caches = { default: {
    async match(request) { return cache.get(request.url)?.clone(); },
    async put(request, response) { cache.set(request.url, response.clone()); },
  } };
  function run(id, initiatedAt, quotes, options = {}) {
    database.prepare("INSERT INTO benchmark_runs(id, pair_id, amount_id, mode, initiated_at, created_at, oracle_captured_at, completed_at, status, sweep_id) VALUES(?, ?, ?, 'optimized', ?, ?, ?, ?, ?, 'unfinished-sweep')")
      .run(id, options.routeId ?? routeId, options.amountId ?? "500000", initiatedAt,
        initiatedAt.replace("T", " ").slice(0, 19), options.oracle === false ? null : initiatedAt,
        options.pending ? null : initiatedAt, options.pending ? "pending" : "complete");
    for (const quote of quotes) database.prepare("INSERT INTO protocol_quotes(run_id, protocol, status, expected_output_formatted, oracle_gap_bps) VALUES(?, ?, ?, ?, ?)")
      .run(id, quote.protocol, quote.status ?? "quoted", quote.output == null ? null : String(quote.output), quote.oracleGapBps ?? null);
  }
  function latest(id, updatedAt = "2026-10-08T16:35:00.000Z") {
    database.exec("DELETE FROM latest_quote_payloads");
    database.prepare("INSERT INTO latest_quote_payloads(run_id, pair_id, amount_id, mode, updated_at) VALUES(?, ?, '500000', 'optimized', ?)").run(id, routeId, updatedAt);
  }
  function archive(runs) {
    database.exec("DELETE FROM trend_buckets");
    for (const seconds of [3600, 14400]) database.prepare("INSERT INTO trend_buckets VALUES(?, '500000', 'optimized', ?, '2026-10-08T16:00:00.000Z', ?)")
      .run(routeId, seconds, JSON.stringify(runs));
  }
  t.after(() => { Date.now = previousNow; database.close(); delete globalThis.caches; delete globalThis.__trendTestEnv.DB; });
  run(1, oldAt, oldQuotes);
  run(2, latestAt, latestQuotes);
  latest(2);
  archive([{ runId: 1, initiatedAt: oldAt, quotes: oldQuotes }]);
  return { database, queries, cache, run, latest, archive };
}

async function response(params = {}) {
  return GET(new Request(`https://swaprank.test/api/trends?${new URLSearchParams({ routeId, amountId: "500000", days: "1", protocols: "thorchain,chainflip,near-intents,maya", ...params })}`));
}

test("a completed route comparison appears while the overall sweep is still running", async (t) => {
  const { database } = fixture(t);
  const result = await response();
  assert.equal(result.status, 200);
  const data = await result.json();
  assert.equal(database.prepare("SELECT status FROM collector_sweeps").get().status, "running");
  assert.equal(data.comparableRuns, 2);
  assert.equal(data.latestRunId, 2);
  assert.equal(data.latestComparisonAt, latestAt);
  const point = data.buckets.at(-1);
  assert.equal(point.timestamp, Date.parse(latestAt));
  assert.equal(point.points.find((p) => p.protocol === "thorchain").winRate, 1);
  assert.equal(point.points.find((p) => p.protocol === "chainflip").winRate, 0);
  assert.equal(point.points.find((p) => p.protocol === "near-intents").oracleGapBps, null);
});

test("archived and recent copies of one batch count once in both points and win shares", async (t) => {
  const { archive } = fixture(t);
  archive([{ runId: 1, initiatedAt: oldAt, quotes: oldQuotes }, { runId: 2, initiatedAt: latestAt, quotes: latestQuotes }]);
  const data = await (await response()).json();
  assert.equal(data.comparableRuns, 2);
  assert.equal(data.buckets.length, 2);
  assert.equal(data.summary.find((p) => p.protocol === "thorchain").winRate, 0.5);
  assert.equal(data.summary.find((p) => p.protocol === "chainflip").sampleCount, 2);
});

test("a new real batch changes the cache revision without repeating history reads for the same batch", async (t) => {
  const { queries, cache, run, latest } = fixture(t);
  await (await response()).json();
  const tailReads = () => queries.filter((sql) => sql.startsWith("WITH recent_runs")).length;
  assert.equal(tailReads(), 1);
  await (await response({ refresh: "unrelated" })).json();
  assert.equal(tailReads(), 1);
  run(3, "2026-10-08T16:33:00.000Z", oldQuotes);
  latest(3);
  const fresh = await (await response()).json();
  assert.equal(fresh.latestRunId, 3);
  assert.equal(fresh.comparableRuns, 3);
  assert.equal(tailReads(), 2);
  assert.equal(cache.size, 2);
});

test("the graph can use the same batch as the latest comparison card, excluding newer archived or raw batches", async (t) => {
  const { run, latest, archive } = fixture(t);
  run(3, "2026-10-08T16:33:00.000Z", oldQuotes);
  latest(3);
  archive([{ runId: 1, initiatedAt: oldAt, quotes: oldQuotes }, { runId: 3, initiatedAt: "2026-10-08T16:33:00.000Z", quotes: oldQuotes }]);
  const data = await (await response({ runId: "2" })).json();
  assert.equal(data.latestRunId, 2);
  assert.equal(data.latestComparisonAt, latestAt);
  assert.equal(data.comparableRuns, 2);
  assert.equal(data.buckets.at(-1).points.find((p) => p.protocol === "thorchain").winRate, 1);
});

test("pending, foreign, and oracle-free batches cannot mint graph cache revisions", async (t) => {
  const { run, cache } = fixture(t);
  run(3, latestAt, latestQuotes, { pending: true });
  run(4, latestAt, latestQuotes, { routeId: "foreign-route" });
  run(5, latestAt, latestQuotes, { oracle: false });
  run(6, latestAt, latestQuotes, { amountId: "1000" });
  for (const runId of ["3", "4", "5", "6", "999", "NaN", "2.5", "0"]) assert.equal((await response({ runId })).status, 400);
  assert.equal(cache.size, 0);
});

test("new route batches preserve ties and missing quotes in long-window bucket medians", async (t) => {
  const { run, latest } = fixture(t);
  run(3, "2026-10-08T16:33:00.000Z", [
    { protocol: "thorchain", output: 206, oracleGapBps: -10 },
    { protocol: "chainflip", output: 206, oracleGapBps: -10 },
    { protocol: "near-intents", status: "error", output: null, oracleGapBps: null },
  ]);
  latest(3);
  const data = await (await response({ days: "14" })).json();
  assert.equal(data.pointMode, "bucket_median");
  assert.equal(data.comparableRuns, 3);
  assert.equal(data.summary.find((p) => p.protocol === "thorchain").winRate, 0.5);
  assert.equal(data.summary.find((p) => p.protocol === "chainflip").winRate, 0.5);
  assert.equal(data.summary.find((p) => p.protocol === "near-intents").sampleCount, 0);
});

test("trend cache keys retain validated batch identity while ignoring arbitrary refresh parameters", () => {
  const url = `https://swaprank.test/api/trends?routeId=${routeId}&amountId=500000&runId=2`;
  assert.match(canonicalPublicCacheUrl(new Request(url)), /schema=6/);
  assert.equal(canonicalPublicCacheUrl(new Request(url)), canonicalPublicCacheUrl(new Request(`${url}&v=noisy&refresh=123`)));
  assert.notEqual(canonicalPublicCacheUrl(new Request(url)), canonicalPublicCacheUrl(new Request(url.replace("runId=2", "runId=3"))));
});

async function leaderboard(params = {}) {
  return comparisonGET(new Request(`https://swaprank.test/api/comparison?${new URLSearchParams({ window: "now", ...params })}`));
}
async function runResponse(params = {}) {
  return runsGET(new Request(`https://swaprank.test/api/runs?${new URLSearchParams({ routeId, amountId: "500000", ...params })}`));
}

test("leaderboard, comparison card, and final chart point switch together when a newer batch completes", async (t) => {
  const { run, latest, queries } = fixture(t);
  const first = await (await leaderboard()).json();
  const firstCard = await (await runResponse()).json();
  assert.equal(first.cells[0].runId, 2);
  assert.equal(first.cells[0].leader, "thorchain");
  assert.equal(firstCard.run.id, 2);
  const historyReads = () => queries.filter((sql) => sql.includes("WITH latest AS")).length;
  await (await leaderboard({ revision: "f".repeat(64), refresh: "arbitrary" })).json();
  assert.equal(historyReads(), 1);
  run(3, "2026-10-08T16:33:00.000Z", oldQuotes);
  latest(3);
  const next = await (await leaderboard()).json();
  const card = await (await runResponse()).json();
  const chart = await (await response({ runId: String(next.cells[0].runId) })).json();
  assert.equal(next.cells[0].leader, "chainflip");
  assert.equal(next.cells[0].runId, 3);
  assert.equal(card.run.id, next.cells[0].runId);
  assert.equal(card.run.initiatedAt, next.cells[0].capturedAt);
  assert.equal(chart.latestRunId, card.run.id);
  assert.equal(chart.buckets.at(-1).points.find((p) => p.protocol === next.cells[0].leader).winRate, 1);
  assert.equal(historyReads(), 2);
});

test("opening a leaderboard cell keeps its batch even if a newer batch completes before navigation", async (t) => {
  const { run, latest } = fixture(t);
  const cell = (await (await leaderboard()).json()).cells[0];
  run(3, "2026-10-08T16:33:00.000Z", oldQuotes);
  latest(3);
  const card = await (await runResponse({ runId: String(cell.runId) })).json();
  const chart = await (await response({ runId: String(cell.runId) })).json();
  assert.equal(card.run.id, cell.runId);
  assert.equal(chart.latestRunId, cell.runId);
  assert.equal(chart.latestComparisonAt, cell.capturedAt);
  const winner = [...card.quotes].sort((a, b) => Number(b.expectedOutputFormatted) - Number(a.expectedOutputFormatted))[0].protocol;
  assert.equal(winner, cell.leader);
});

test("a late completed batch changes the leaderboard cache even when a different route already has a larger run ID", async (t) => {
  const { run, database, queries } = fixture(t);
  run(100, latestAt, oldQuotes, { routeId: "other-route" });
  database.prepare("INSERT INTO latest_quote_payloads(run_id, pair_id, amount_id, mode, updated_at) VALUES(100, 'other-route', '500000', 'optimized', ?)").run("2026-10-08T16:35:00.000Z");
  const before = await (await leaderboard()).json();
  assert.equal(before.cells.find((c) => c.pairId === routeId).leader, "thorchain");
  run(3, "2026-10-08T16:33:00.000Z", oldQuotes);
  database.prepare("UPDATE latest_quote_payloads SET run_id = 3 WHERE pair_id = ?").run(routeId);
  const after = await (await leaderboard()).json();
  assert.equal(after.cells.find((c) => c.pairId === routeId).leader, "chainflip");
  const sql = queries.find((q) => q.includes("GROUP_CONCAT(entry"));
  const plan = database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all("optimized");
  assert.ok(plan.some((p) => p.detail.includes("COVERING INDEX idx_latest_quote_payloads_revision")));
  assert.equal((await (await runResponse({ runId: "100" })).json()).run, null);
});
