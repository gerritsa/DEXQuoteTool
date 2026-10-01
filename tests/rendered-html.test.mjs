import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { canonicalPublicCacheUrl } from "../lib/http-cache.ts";
import { oracleGapBps, referenceForAmount } from "../lib/oracle.ts";

async function render(path = "/", environment = {}) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(new Request(`http://localhost${path}`, { headers: { accept: "text/html" } }), {
    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
    ...environment,
  }, { waitUntil() {}, passThroughOnException() {} });
}

test("server-renders the SwapRank dashboard", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<title>SwapRank/);
  assert.match(html, /href="\/favicon\.svg"/);
  assert.match(html, /QUOTE LEADERBOARD/);
  assert.match(html, /Cross-chain DEX quotes compared by trade size/);
  assert.match(html, /Switch to light mode/);
  assert.match(html, /\$500/);
  assert.doesNotMatch(html, />\$10</);
  assert.doesNotMatch(html, />\$100</);
  assert.match(html, /\$10K/);
  assert.match(html, /7 days/);
  assert.match(html, /14 days/);
  assert.match(html, /30 days/);
  assert.match(html, /Latest check/);
  assert.match(html, /Refresh page data/);
  assert.match(html, /Loading ranked routes/);
  assert.match(html, /leaderboard-skeleton-row/);
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /Compare protocols/);
  assert.doesNotMatch(html, /Execution mode|Standard swap|Streaming\/DCA/);
  assert.match(html, /\/partners\/near\.svg/);
  assert.match(html, /\/partners\/chainflip\.svg/);
  assert.match(html, /\/partners\/thorchain\.png/);
  assert.match(html, /\/partners\/maya\.svg/);
  assert.match(html, /MAYA PROTOCOL/);
  assert.match(html, /THORChain[\s\S]*MAYA PROTOCOL[\s\S]*CHAINFLIP[\s\S]*NEAR/);
  assert.doesNotMatch(html, /Maya is disabled|MAYA PROTOCOL · DISABLED/);
  assert.doesNotMatch(html, /Route analysis/);
  assert.doesNotMatch(html, />Exact input</);
  assert.doesNotMatch(html, /Run \$.*test/);
  assert.doesNotMatch(html, /Real requests\. Exact sizes\. Explainable winners\./);
});

test("route analysis renders on a dedicated, bookmarkable page", async () => {
  const response = await render("/routes/bitcoin%3Anative%3Abtc__ethereum%3Anative%3Aeth?size=10000&days=7&back=%2F%3Fwindow%3D7d%23leaderboard-results");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Route analysis · best-output quotes/);
  assert.match(html, /← Back to leaderboard/);
  assert.match(html, /href="\/\?window=7d#leaderboard-results"/);
  assert.doesNotMatch(html, /QUOTE LEADERBOARD/);
});

test("health endpoint covers stale sweeps, partial routes, and partner errors", async () => {
  const source = await readFile(new URL("../app/api/health/route.ts", import.meta.url), "utf8");
  assert.match(source, /minutesSinceTerminal > 75/);
  assert.match(source, /missingRoutes\.length/);
  assert.match(source, /errorRate > 0\.2/);
  assert.match(source, /AS unavailable/);
  assert.match(source, /response_http_status >= 500/);
  assert.match(source, /operational quote errors exceeded 20%/);
  assert.match(source, /oracleCoverage < 0\.9/);
  assert.match(source, /Live collection is paused until fresh route pricing is available/);
  assert.match(source, /FROM catalog_state/);
  assert.match(source, /status === "healthy" \? 200 : 503/);
});

test("route catalog keeps a durable display fallback while protecting benchmark freshness", async () => {
  const catalog = await readFile(new URL("../lib/routes/catalog.ts", import.meta.url), "utf8");
  const routes = await readFile(new URL("../app/api/routes/route.ts", import.meta.url), "utf8");
  const collector = await readFile(new URL("../lib/collector.ts", import.meta.url), "utf8");
  assert.match(catalog, /INSERT INTO catalog_state/);
  assert.match(catalog, /source: "stored"/);
  assert.match(catalog, /source: "static"/);
  assert.match(routes, /allowStale: true, allowStatic: true/);
  assert.match(collector, /benchmarkCatalogGraceMs/);
  assert.match(collector, /Benchmark collection paused because fresh catalog pricing is unavailable/);
});

test("SOL routes keep working across the paused THORChain rollout", async () => {
  const catalog = await readFile(new URL("../lib/routes/catalog.ts", import.meta.url), "utf8");
  const run = await readFile(new URL("../lib/quotes/run.ts", import.meta.url), "utf8");
  const pool = await readFile(new URL("../lib/quotes/adapters/pool-protocol.ts", import.meta.url), "utf8");
  assert.match(catalog, /chainflipId: "Sol", chain: "Solana", symbol: "SOL"/);
  assert.match(catalog, /"SOL\.SOL": 9/);
  assert.match(catalog, /\["BTC\.BTC", "SOL\.SOL"\]/);
  assert.match(run, /BENCHMARK_SOL_ADDRESS/);
  assert.match(pool, /trading \(\?:is \)\?\(\?:halted\|paused\)/);
});

test("ZEC routes collect through Maya and NEAR before the THORChain pool launches", async () => {
  const catalog = await readFile(new URL("../lib/routes/catalog.ts", import.meta.url), "utf8");
  const run = await readFile(new URL("../lib/quotes/run.ts", import.meta.url), "utf8");
  const env = await readFile(new URL("../.env.example", import.meta.url), "utf8");
  assert.match(catalog, /ZEC: "zcash"/);
  assert.match(catalog, /thorchain: \{ source: Boolean\(pool\), destination: Boolean\(pool\), assetId: pool\?\.asset \}/);
  assert.match(catalog, /\["ZEC\.ZEC", "BTC\.BTC"\]/);
  assert.match(catalog, /\["ZEC\.ZEC", "ETH\.ETH"\]/);
  assert.match(catalog, /\["ZEC\.ZEC", "ETH\.USDC-/);
  assert.match(catalog, /thorAsset: "ZEC\.ZEC", chain: "zcash", symbol: "ZEC", decimals: 8, mayaAssetId: "ZEC\.ZEC"/);
  assert.match(run, /BENCHMARK_ZEC_ADDRESS/);
  assert.match(run, /chain === "zcash"/);
  assert.match(env, /BENCHMARK_ZEC_ADDRESS=/);
});

test("quote adapters separate expected unavailability from operational errors", async () => {
  const chainflip = await readFile(new URL("../lib/quotes/adapters/chainflip.ts", import.meta.url), "utf8");
  const pool = await readFile(new URL("../lib/quotes/adapters/pool-protocol.ts", import.meta.url), "utf8");
  const near = await readFile(new URL("../lib/quotes/adapters/near-intents.ts", import.meta.url), "utf8");
  const response = await readFile(new URL("../lib/quotes/adapters/response.ts", import.meta.url), "utf8");
  assert.match(chainflip, /INSUFFICIENT_LIQUIDITY/);
  assert.match(chainflip, /INVALID_RESPONSE/);
  assert.match(chainflip, /readQuoteJsonResponse/);
  assert.match(chainflip, /isVaultSwap", "true"/);
  assert.match(chainflip, /dcaV2Enabled", "true"/);
  assert.match(chainflip, /function bestOutputQuote/);
  assert.match(chainflip, /output > bestOutput/);
  assert.doesNotMatch(chainflip, /isOnChain/);
  assert.match(pool, /readQuoteJsonResponse/);
  assert.match(near, /readQuoteJsonResponse/);
  assert.match(response, /await response\.text\(\)/);
  assert.match(response, /returned a non-JSON response/);
  assert.match(response, /maxStoredResponseChars = 8_000/);
  assert.match(chainflip, /catch \(error\)[\s\S]*strategy: requestedStrategy/);
  assert.match(pool, /total_swap_seconds/);
  assert.match(pool, /protocol === "thorchain" \? "0" : "1"/);
  assert.match(pool, /streaming_quantity", "0"/);
  assert.match(pool, /min\(\?:imum\)\?/);
  assert.match(near, /INSUFFICIENT_LIQUIDITY/);
});

test("latest comparisons use the bounded latest-payload lookup while inputs remain durable", async () => {
  const comparison = await readFile(new URL("../app/api/comparison/route.ts", import.meta.url), "utf8");
  const run = await readFile(new URL("../lib/quotes/run.ts", import.meta.url), "utf8");
  const schema = await readFile(new URL("../db/schema.ts", import.meta.url), "utf8");
  assert.match(comparison, /FROM latest_quote_payloads/);
  assert.doesNotMatch(comparison, /WITH ranked_runs AS/);
  assert.match(comparison, /completed_at IS NOT NULL/);
  assert.match(run, /requestJson: JSON\.stringify\(request\)/);
  assert.match(run, /async function finalizeRun/);
  assert.match(run, /await d1\.batch\(\[/);
  assert.match(schema, /requestJson: text\("request_json"\)/);
  assert.match(schema, /oracleGapBps: real\("oracle_gap_bps"\)/);
});

test("oracle references normalize quotes against a shared cross-rate", () => {
  const reference = referenceForAmount({
    sourceSymbol: "BTC",
    destinationSymbol: "ETH",
    sourcePriceUsd: 80_000,
    destinationPriceUsd: 2_000,
    capturedAt: "2026-08-30T00:00:00.000Z",
  }, "100000000", 8);
  assert.equal(reference?.referenceOutput, 40);
  assert.equal(oracleGapBps("40", reference), 0);
  assert.ok(Math.abs(oracleGapBps("39.8", reference) + 50) < 1e-9);
});

test("catalog failures and trend availability are not reported as successful support", async () => {
  const catalog = await readFile(new URL("../lib/routes/catalog.ts", import.meta.url), "utf8");
  const trends = await readFile(new URL("../app/api/trends/route.ts", import.meta.url), "utf8");
  assert.match(catalog, /NEAR Intents catalog unavailable/);
  assert.match(catalog, /Chainflip catalog unavailable/);
  assert.match(trends, /availability\.successes \/ availability\.attempts/);
  assert.match(trends, /FROM daily_comparison_metrics/);
  assert.doesNotMatch(trends, /quotes\.length < 2/);
});

test("Maya Protocol is enabled across discovery, collection, APIs, and the dashboard", async () => {
  const catalog = await readFile(new URL("../lib/routes/catalog.ts", import.meta.url), "utf8");
  const run = await readFile(new URL("../lib/quotes/run.ts", import.meta.url), "utf8");
  const collector = await readFile(new URL("../lib/collector.ts", import.meta.url), "utf8");
  const comparison = await readFile(new URL("../app/api/comparison/route.ts", import.meta.url), "utf8");
  const trends = await readFile(new URL("../app/api/trends/route.ts", import.meta.url), "utf8");
  const dashboard = await readFile(new URL("../app/swap-rank-dashboard.tsx", import.meta.url), "utf8");

  assert.match(catalog, /MAYA_POOLS = "https:\/\/mayanode\.mayachain\.info\/mayachain\/pools"/);
  assert.match(catalog, /maya: \{ source: Boolean\(mayaAsset\), destination: Boolean\(mayaAsset\), assetId: mayaAsset \}/);
  assert.match(run, /const allProtocols: ProtocolId\[\] = \["thorchain", "chainflip", "near-intents", "maya"\]/);
  assert.match(collector, /const protocols: ProtocolId\[\] = \["thorchain", "chainflip", "near-intents", "maya"\]/);
  assert.match(comparison, /const metricProtocolOrder: PartnerId\[\] = \["thorchain", "chainflip", "near-intents", "maya"\]/);
  assert.match(trends, /const metricProtocolOrder: PartnerId\[\] = \["thorchain", "chainflip", "near-intents", "maya"\]/);
  assert.doesNotMatch(dashboard, /Maya is disabled|id: "maya"[^\n]+disabled: true/);
});

test("does not expose a public collector page", async () => {
  const response = await render("/collector");
  assert.equal(response.status, 404);
});

test("build includes the production collection bindings", async () => {
  const config = JSON.parse(await readFile(new URL("../dist/server/wrangler.json", import.meta.url), "utf8"));
  assert.deepEqual(config.triggers.crons, ["*/30 * * * *", "15 0 * * *"]);
  assert.equal(config.r2_buckets[0].binding, "ARCHIVE");
  assert.equal(config.queues.producers[0].binding, "BENCHMARK_QUEUE");
  assert.equal(config.queues.consumers[0].max_batch_size, 1);
  assert.equal(config.queues.consumers[0].max_concurrency, 4);
  assert.equal(config.queues.consumers[0].dead_letter_queue, "dex-quote-tool-dead-letter");
});

test("the clean baseline includes collector resilience and precomputed trends", async () => {
  const migration = await readFile(new URL("../drizzle/0000_true_spot.sql", import.meta.url), "utf8");
  assert.match(migration, /missing_routes_json/);
  assert.match(migration, /idx_benchmark_runs_initiated/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS `trend_buckets`/);
  assert.match(migration, /idx_trend_buckets_lookup/);
});

test("oracle migration starts benchmark history fresh", async () => {
  const migration = await readFile(new URL("../drizzle/0003_windy_enchantress.sql", import.meta.url), "utf8");
  assert.match(migration, /oracle_source_price_usd/);
  assert.match(migration, /oracle_gap_bps/);
  assert.match(migration, /DELETE FROM `protocol_quotes`/);
  assert.match(migration, /DELETE FROM `benchmark_runs`/);
  assert.match(migration, /DELETE FROM `trend_buckets`/);
});

test("leaderboard and graph use fifteen-minute shared caching", async () => {
  const comparison = await readFile(new URL("../app/api/comparison/route.ts", import.meta.url), "utf8");
  const trends = await readFile(new URL("../app/api/trends/route.ts", import.meta.url), "utf8");
  assert.match(comparison, /publicCacheHeaders\(900\)/);
  assert.match(trends, /FROM trend_buckets/);
  assert.match(trends, /oracleGapBps: quote\.oracleGapBps/);
  assert.match(trends, /baseline: "thorchain_cex_oracle"/);
  assert.match(trends, /days <= 7 \? "comparison" : "bucket_median"/);
  assert.match(trends, /publicCacheHeaders\(900\)/);
  assert.match(await readFile(new URL("../app/swap-rank-dashboard.tsx", import.meta.url), "utf8"), /Every point compares the quoted output/);
});

test("historical leaderboard queries use window indexes without unused median work", async () => {
  const comparison = await readFile(new URL("../app/api/comparison/route.ts", import.meta.url), "utf8");
  const collector = await readFile(new URL("../lib/collector.ts", import.meta.url), "utf8");
  const indexMigration = await readFile(new URL("../drizzle/0006_yielding_rhodey.sql", import.meta.url), "utf8");
  const compactMigration = await readFile(new URL("../drizzle/0007_flippant_ben_parker.sql", import.meta.url), "utf8");
  assert.doesNotMatch(comparison, /median_output|ROW_NUMBER\(\) OVER \(PARTITION BY run_id ORDER BY output\)/);
  assert.doesNotMatch(collector, /median_output|ROW_NUMBER\(\) OVER \(PARTITION BY run_id ORDER BY output\)/);
  assert.match(collector, /masks\.sort\(\(left, right\) => right\.length - left\.length\)/);
  assert.match(indexMigration, /idx_benchmark_runs_mode_initiated/);
  assert.match(compactMigration, /CREATE INDEX `idx_daily_metrics_window` ON `daily_comparison_metrics` \(`mode`,`day`\)/);
  assert.match(compactMigration, /json_object\('p', json\(p\.`protocols_json`\), 'w'/);
  assert.match(compactMigration, /WHERE `mode` = 'optimized'/);
  assert.match(comparison, /json_extract\(d\.metrics_json/);
});

test("daily metric migration compacts filters without retaining standard-mode aggregates", async () => {
  const migration = await readFile(new URL("../drizzle/0007_flippant_ben_parker.sql", import.meta.url), "utf8");
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE pool_depth_snapshots (id text PRIMARY KEY, captured_at text NOT NULL, pools_json text NOT NULL, created_at text NOT NULL);
    INSERT INTO pool_depth_snapshots VALUES ('old', '2026-09-30T00:00:00Z', '{}', '2026-09-30T00:00:00Z');
    CREATE TABLE daily_comparison_metrics (
      id text PRIMARY KEY NOT NULL, day text NOT NULL, pair_id text NOT NULL, amount_id text NOT NULL,
      mode text NOT NULL, protocol_mask text NOT NULL, protocol text NOT NULL, attempts integer NOT NULL,
      successes integer NOT NULL, comparable_samples integer NOT NULL, edge_sum_bps real NOT NULL,
      oracle_samples integer NOT NULL, oracle_gap_sum_bps real NOT NULL, wins real NOT NULL,
      latest_at text NOT NULL, created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
    CREATE INDEX idx_daily_metrics_lookup ON daily_comparison_metrics (pair_id, amount_id, mode, day);
    CREATE INDEX idx_daily_metrics_day_mask ON daily_comparison_metrics (day, protocol_mask);
    CREATE INDEX idx_daily_metrics_window ON daily_comparison_metrics (protocol_mask, mode, day, protocol);
    INSERT INTO daily_comparison_metrics
      (id, day, pair_id, amount_id, mode, protocol_mask, protocol, attempts, successes,
       comparable_samples, edge_sum_bps, oracle_samples, oracle_gap_sum_bps, wins, latest_at)
    VALUES
      ('a', '2026-09-30', 'BTC-ETH', 'usd-1000', 'optimized', 'thorchain,near-intents', 'thorchain', 48, 47, 47, 0, 47, -1000, 30, '2026-09-30T23:30:00Z'),
      ('b', '2026-09-30', 'BTC-ETH', 'usd-1000', 'optimized', 'thorchain,near-intents', 'near-intents', 48, 46, 46, 0, 46, -900, 18, '2026-09-30T23:30:00Z'),
      ('c', '2026-09-30', 'BTC-ETH', 'usd-1000', 'standard', 'thorchain,near-intents', 'thorchain', 48, 48, 48, 0, 48, -800, 31, '2026-09-30T23:30:00Z');
  `);
  database.exec(migration);
  const rows = database.prepare("SELECT mode, metrics_json AS metricsJson FROM daily_comparison_metrics").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].mode, "optimized");
  const metrics = JSON.parse(rows[0].metricsJson);
  assert.deepEqual(metrics.p.thorchain.slice(0, 4), [48, 47, 47, 47]);
  assert.equal(metrics.w["thorchain,near-intents"].thorchain, 30);
  assert.equal(metrics.w["thorchain,near-intents"]["near-intents"], 18);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM pool_depth_snapshots").get().count, 0);
  database.close();
});

test("trend lines preserve missing quote slots without changing best-available winner scoring", async () => {
  const trends = await readFile(new URL("../app/api/trends/route.ts", import.meta.url), "utf8");
  const page = await readFile(new URL("../app/swap-rank-dashboard.tsx", import.meta.url), "utf8");
  assert.match(trends, /expectedCollectionIntervalMs = 30 \* 60 \* 1000/);
  assert.match(trends, /const comparisonRuns = \[\.\.\.new Map\(storedRuns/);
  assert.match(trends, /expectedIntervalMs: expectedCollectionIntervalMs/);
  assert.doesNotMatch(trends, /quotes\.length < 2/);
  assert.match(page, /if \(!slot\.point \|\| slot\.value == null\) \{[\s\S]*?current = undefined/);
  assert.doesNotMatch(page, /trend-missing-point|hollow point|no quote for this check/);
  assert.match(page, /if only one DEX returns a quote, it wins/);
  assert.match(page, /function trendAvailabilityLabel/);
  assert.match(page, /data\.expectedIntervalMs \?\? 30 \* 60 \* 1000/);
});

test("the dashboard refreshes stale long-lived tabs", async () => {
  const page = await readFile(new URL("../app/swap-rank-dashboard.tsx", import.meta.url), "utf8");
  const cache = await readFile(new URL("../lib/http-cache.ts", import.meta.url), "utf8");
  assert.match(page, /visibilitychange/);
  assert.match(page, /pageRefreshIntervalMs = 15 \* 60_000/);
  assert.match(page, /manualRefreshCooldownMs = 60_000/);
  assert.match(page, /Refresh page data/);
  assert.match(page, /Refresh available after cooldown/);
  assert.doesNotMatch(page, /params\.set\("refresh"/);
  assert.match(cache, /canonicalPublicCacheUrl/);
  assert.match(cache, /publicCacheKey/);
});

test("public cache keys ignore cache-busting and irrelevant parameters", () => {
  const semantic = "https://swaprank.test/api/trends?routeId=eth_btc&amountId=500000&days=7&protocols=thorchain,chainflip,near-intents";
  const noisy = `${semantic}&refresh=999&v=random&junk=anything`;
  assert.equal(
    canonicalPublicCacheUrl(new Request(noisy)),
    canonicalPublicCacheUrl(new Request(semantic)),
  );
  assert.equal(
    canonicalPublicCacheUrl(new Request("https://swaprank.test/api/routes?refresh=999&junk=anything")),
    "https://swaprank.test/api/routes",
  );
  assert.match(
    canonicalPublicCacheUrl(new Request("https://swaprank.test/api/trends?routeId=eth_btc&amountId=500000")),
    /[?&]days=1(?:&|$)/,
  );
  assert.equal(
    canonicalPublicCacheUrl(new Request("https://swaprank.test/api/runs?runId=42&routeId=ignored&junk=anything")),
    "https://swaprank.test/api/runs?schema=8&runId=42",
  );
  assert.match(
    canonicalPublicCacheUrl(new Request("https://swaprank.test/api/comparison?protocols=thorchain,maya")),
    /[?&]protocols=thorchain%2Cmaya(?:&|$)/,
  );
  assert.equal(
    canonicalPublicCacheUrl(new Request(`${semantic}&mode=standard`)),
    canonicalPublicCacheUrl(new Request(semantic)),
  );
});

test("collection uses one best-output strategy per route and size", async () => {
  const collector = await readFile(new URL("../lib/collector.ts", import.meta.url), "utf8");
  const protocols = await readFile(new URL("../lib/quotes/protocols.ts", import.meta.url), "utf8");
  const pool = await readFile(new URL("../lib/quotes/adapters/pool-protocol.ts", import.meta.url), "utf8");
  const chainflip = await readFile(new URL("../lib/quotes/adapters/chainflip.ts", import.meta.url), "utf8");
  const dashboard = await readFile(new URL("../app/swap-rank-dashboard.tsx", import.meta.url), "utf8");
  const cache = await readFile(new URL("../lib/http-cache.ts", import.meta.url), "utf8");

  assert.match(protocols, /bestOutputMode: ExecutionMode = "optimized"/);
  assert.match(collector, /quoteSizes\.map\(\(size\) => \(\{ routeId: route\.id, amountId: size\.id, mode: bestOutputMode \}\)\)/);
  assert.doesNotMatch(collector, /const modes/);
  assert.match(pool, /streaming_quantity", "0"/);
  assert.match(chainflip, /dcaV2Enabled", "true"/);
  assert.match(chainflip, /bestOutputQuote\(quotes\)/);
  assert.doesNotMatch(dashboard, /executionMode|Execution mode|Standard swap|Streaming\/DCA/);
  assert.doesNotMatch(cache, /normalizedMode/);
});

test("the retired pool and execution analysis stays out of active product code", async () => {
  const collector = await readFile(new URL("../lib/collector.ts", import.meta.url), "utf8");
  const run = await readFile(new URL("../lib/quotes/run.ts", import.meta.url), "utf8");
  const api = await readFile(new URL("../app/api/runs/route.ts", import.meta.url), "utf8");
  const page = await readFile(new URL("../app/swap-rank-dashboard.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const migration = await readFile(new URL("../drizzle/0005_productive_gertrude_yorkes.sql", import.meta.url), "utf8");
  assert.doesNotMatch(collector, /poolDepthSnapshotFromAssets|INSERT INTO pool_depth_snapshots/);
  assert.doesNotMatch(run, /analyzeThorQuote|poolDepthSnapshot/);
  assert.doesNotMatch(api, /parsedDepthForecast|depthForecast:/);
  assert.doesNotMatch(page, /Pool \+ execution|ThorAnalysisCard|depthForecast|analysis-view-tabs/);
  assert.doesNotMatch(styles, /depth-forecast|pool-rate-panel|analysis-view-tabs/);
  // Keep the historical schema migration intact so retiring the feature is non-destructive.
  assert.match(migration, /ADD `depth_forecast_json` text/);
});

test("route analysis keeps the latest synchronized DEX outputs visible", async () => {
  const page = await readFile(new URL("../app/swap-rank-dashboard.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(page, /window\.history\.replaceState\(null, "", leaderboardReturnHref\(\)\)/);
  assert.match(page, /function LatestQuoteComparison/);
  assert.match(page, /Latest quote comparison/);
  assert.match(page, /Exact input/);
  assert.match(page, /vs best/);
  assert.match(page, /vs oracle/);
  assert.match(page, /Raw details/);
  assert.match(page, /setRequestsOpen\(true\)/);
  assert.match(styles, /:root\[data-theme="light"\] \.route-telemetry/);
  assert.match(styles, /:root\[data-theme="light"\] \.latest-comparison/);
  assert.match(styles, /:root\[data-theme="light"\] \.filter-bar/);
  assert.match(styles, /:root\[data-theme="light"\] \.asset-select-menu/);
});

test("the raw details drawer navigates retained quote batches", async () => {
  const page = await readFile(new URL("../app/swap-rank-dashboard.tsx", import.meta.url), "utf8");
  const runs = await readFile(new URL("../app/api/runs/route.ts", import.meta.url), "utf8");
  const retention = await readFile(new URL("../lib/quotes/retention.ts", import.meta.url), "utf8");
  assert.match(page, /function navigateRunDetails/);
  assert.match(page, /← Previous/);
  assert.match(page, /Next →/);
  assert.match(page, /Raw history is retained for \{rawArchiveRetentionDays\} days/);
  assert.doesNotMatch(page, /onInspectRun/);
  assert.match(runs, /raw_archive_key AS rawArchiveKey/);
  assert.match(runs, /archiveBucket\.get\(bundle\.rawArchiveKey\)/);
  assert.match(runs, /new DecompressionStream\("gzip"\)/);
  assert.match(runs, /candidate\.runId === run\.id/);
  assert.match(runs, /rawDetailsAvailable/);
  assert.match(runs, /WITH available_runs AS/);
  assert.match(runs, /previous_run AS/);
  assert.match(runs, /next_run AS/);
  assert.match(runs, /Date\.now\(\) - rawArchiveRetentionMs/);
  assert.match(retention, /rawArchiveRetentionDays = 7/);
});

test("leaderboard uses THORChain green and compact unranked asset paths", async () => {
  const page = await readFile(new URL("../app/swap-rank-dashboard.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(page, /function LeaderboardRoutePath/);
  assert.match(page, /asset\.thorAsset\.split\("-"\)\[0\]/);
  assert.doesNotMatch(page, /mobile-route-rank/);
  assert.doesNotMatch(page, /String\(index \+ 1\)/);
  assert.match(styles, /--acid:#17b897/);
  assert.match(styles, /--brand-accent:#17b897/);
  assert.doesNotMatch(styles, /#d1ff45|#d6ff4b/);
});

test("expanded route filters require two supported protocols and render every asset", async () => {
  const page = await readFile(new URL("../app/swap-rank-dashboard.tsx", import.meta.url), "utf8");
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const layout = await readFile(new URL("../app/layout.tsx", import.meta.url), "utf8");
  assert.match(readme, /50 fixed directed routes/);
  assert.match(layout, /across 50 fixed routes/);
  assert.match(page, /function routeMatchesProtocols/);
  assert.match(page, /routeMatchesAssets\(route, selectedAssets\) && routeMatchesProtocols\(route, selectedProtocols\)/);
  assert.match(page, /activeRoutePartnerCount/);
  assert.match(page, /\["bch", "bnb", "doge", "ltc", "sol", "xrp", "zec"\]/);
  for (const symbol of ["bch", "bnb", "doge", "ltc", "sol", "xrp", "zec"]) {
    const logo = await readFile(new URL(`../public/assets/${symbol}.svg`, import.meta.url), "utf8");
    assert.match(logo, /<svg role="img"/);
    assert.match(logo, /<title>/);
  }
  assert.match(page, /className="asset-select-trigger"/);
  assert.match(page, /role="listbox" aria-multiselectable="true"/);
  assert.match(page, /selectedAssets\.slice\(0, visibleAssetCount\)/);
  assert.match(page, /new ResizeObserver\(updateVisibleAssets\)/);
  assert.match(page, /compactChainLabel\(asset\.chain\)/);
  assert.match(page, /className="asset-checkbox"/);
});

test("collector archives fixed-length gzip bodies and preserves finalization errors", async () => {
  const collector = await readFile(new URL("../lib/collector.ts", import.meta.url), "utf8");
  const worker = await readFile(new URL("../worker/index.ts", import.meta.url), "utf8");
  const backfill = await readFile(new URL("../scripts/backfill-trends.sql", import.meta.url), "utf8");
  const lifecycle = JSON.parse(await readFile(new URL("../infra/r2-lifecycle.json", import.meta.url), "utf8"));
  assert.match(collector, /new Response\(compressed\)\.arrayBuffer\(\)/);
  assert.match(collector, /const detailRetentionDays = 8/);
  assert.match(collector, /const aggregateRetentionDays = 2_000/);
  assert.match(collector, /json_object\('p', json\(p\.protocols_json\), 'w', json\(COALESCE\(w\.wins_json, '\{\}'\)\)\)/);
  assert.match(collector, /const deleteBatchSize = 1_000/);
  assert.match(collector, /r\.mode = 'standard' OR r\.initiated_at < \?/);
  assert.match(collector, /pruneTrendHistory/);
  const normalizedRule = lifecycle.rules.find((rule) => rule.conditions?.prefix === "normalized/");
  assert.equal(normalizedRule?.deleteObjectsTransition.condition.maxAge, 2_000 * 24 * 60 * 60);
  assert.match(collector, /Archive upload failed:/);
  assert.match(collector, /status IN \('partial', 'failed'\)/);
  assert.match(worker, /console\.error\("Collector bundle failed"/);
  assert.match(backfill, /CAST\(3600 AS TEXT\)/);
  assert.match(backfill, /CAST\(14400 AS TEXT\)/);
});
