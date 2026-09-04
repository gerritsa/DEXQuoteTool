import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { canonicalPublicCacheUrl } from "../lib/http-cache.ts";
import { oracleGapBps, referenceForAmount } from "../lib/oracle.ts";
import { forecastThorDepth, simulateThorOutput } from "../lib/quotes/depth-forecast.ts";

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
  assert.match(html, /Execution mode/);
  assert.match(html, /Compare protocols/);
  assert.match(html, /Standard swap/);
  assert.match(html, /Streaming\/DCA/);
  assert.match(html, /Execution mode[\s\S]*Streaming\/DCA[\s\S]*Standard swap/);
  assert.match(html, /\/partners\/near\.svg/);
  assert.match(html, /\/partners\/chainflip\.svg/);
  assert.match(html, /\/partners\/thorchain\.png/);
  assert.match(html, /\/partners\/maya\.svg/);
  assert.match(html, /MAYA PROTOCOL/);
  assert.match(html, /THORCHAIN[\s\S]*MAYA PROTOCOL[\s\S]*CHAINFLIP[\s\S]*NEAR/);
  assert.doesNotMatch(html, /Route analysis/);
  assert.doesNotMatch(html, />Exact input</);
  assert.doesNotMatch(html, /Run \$.*test/);
  assert.doesNotMatch(html, /Real requests\. Exact sizes\. Explainable winners\./);
});

test("route analysis renders on a dedicated, bookmarkable page", async () => {
  const response = await render("/routes/bitcoin%3Anative%3Abtc__ethereum%3Anative%3Aeth?size=10000&mode=standard&days=7&back=%2F%3Fwindow%3D7d%23leaderboard-results");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Route analysis · [\s\S]*Standard swap/);
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

test("quote adapters separate expected unavailability from operational errors", async () => {
  const chainflip = await readFile(new URL("../lib/quotes/adapters/chainflip.ts", import.meta.url), "utf8");
  const pool = await readFile(new URL("../lib/quotes/adapters/pool-protocol.ts", import.meta.url), "utf8");
  const near = await readFile(new URL("../lib/quotes/adapters/near-intents.ts", import.meta.url), "utf8");
  const response = await readFile(new URL("../lib/quotes/adapters/response.ts", import.meta.url), "utf8");
  assert.match(chainflip, /INSUFFICIENT_LIQUIDITY/);
  assert.match(chainflip, /STRATEGY_UNAVAILABLE/);
  assert.match(chainflip, /INVALID_RESPONSE/);
  assert.match(chainflip, /readQuoteJsonResponse/);
  assert.match(chainflip, /isVaultSwap", "true"/);
  assert.doesNotMatch(chainflip, /isOnChain/);
  assert.match(pool, /readQuoteJsonResponse/);
  assert.match(near, /readQuoteJsonResponse/);
  assert.match(response, /await response\.text\(\)/);
  assert.match(response, /returned a non-JSON response/);
  assert.match(response, /maxStoredResponseChars = 8_000/);
  assert.match(chainflip, /catch \(error\)[\s\S]*strategy: requestedStrategy/);
  assert.match(pool, /total_swap_seconds/);
  assert.match(pool, /protocol === "thorchain" && request\.mode === "optimized" \? "0" : "1"/);
  assert.match(pool, /min\(\?:imum\)\?/);
  assert.match(near, /INSUFFICIENT_LIQUIDITY/);
});

test("comparison inputs remain durable and latest results do not depend on raw payload retention", async () => {
  const comparison = await readFile(new URL("../app/api/comparison/route.ts", import.meta.url), "utf8");
  const run = await readFile(new URL("../lib/quotes/run.ts", import.meta.url), "utf8");
  const schema = await readFile(new URL("../db/schema.ts", import.meta.url), "utf8");
  assert.match(comparison, /WITH ranked_runs AS/);
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
  const semantic = "https://swaprank.test/api/trends?routeId=eth_btc&amountId=500000&mode=optimized&days=7&protocols=thorchain,chainflip,near-intents";
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
    "https://swaprank.test/api/runs?schema=3&runId=42",
  );
});

test("THORChain depth forecast finds the liquidity threshold and identifies price imbalance", () => {
  const sourcePool = { asset: "BTC.BTC", assetDepth: "10000000000", runeDepth: "10000000000000", liquidityUsd: 10_000_000 };
  const destinationPool = { asset: "ETH.ETH", assetDepth: "400000000000", runeDepth: "10000000000000", liquidityUsd: 8_000_000 };
  const request = {
    pairId: "btc_eth",
    source: { canonicalId: "btc", chain: "bitcoin", symbol: "BTC", decimals: 8, protocolIds: { thorchain: "BTC.BTC" } },
    destination: { canonicalId: "eth", chain: "ethereum", symbol: "ETH", decimals: 18, protocolIds: { thorchain: "ETH.ETH" } },
    sourceAmountBaseUnits: "100000000",
    sourceAmountUsd: 80_000,
    sourcePriceUsd: 80_000,
    mode: "standard",
    recipient: "0xrecipient",
    refundAddress: "bc1refund",
    slippageToleranceBps: 100,
  };
  const thorQuote = {
    protocol: "thorchain",
    strategy: "single",
    status: "quoted",
    expectedOutputFormatted: "38.4",
    requestStartedAt: "2026-09-04T00:00:00.000Z",
    rawResponse: { max_streaming_quantity: 1, fees: { outbound: "0" } },
  };
  const competitor = (output) => ({
    protocol: "chainflip",
    strategy: "regular",
    status: "quoted",
    expectedOutputFormatted: String(output),
    requestStartedAt: "2026-09-04T00:00:00.000Z",
    rawResponse: {},
  });
  const snapshot = { capturedAt: "2026-09-04T00:00:00.000Z", pools: [sourcePool, destinationPool] };

  const current = simulateThorOutput(100_000_000, sourcePool, destinationPool, 1, 1, 1);
  const deeper = simulateThorOutput(100_000_000, sourcePool, destinationPool, 2, 2, 1);
  assert.ok(current && deeper && deeper > current);

  const reachable = forecastThorDepth(request, [thorQuote, competitor(39.2)], snapshot);
  assert.equal(reachable.status, "available");
  assert.equal(reachable.depthAloneSufficient, true);
  assert.ok(reachable.requiredDepthMultiplier > 1 && reachable.requiredDepthMultiplier < 3);
  assert.ok(reachable.requiredAdditionalLiquidityUsd > 0);
  assert.ok(Math.abs(reachable.curve.find((point) => point.multiplier === 1).gapBps - reachable.currentGapBps) < 1e-8);

  const priceLimited = forecastThorDepth(request, [thorQuote, competitor(45)], snapshot);
  assert.equal(priceLimited.status, "available");
  assert.equal(priceLimited.depthAloneSufficient, false);
  assert.equal(priceLimited.requiredDepthMultiplier, null);
  assert.ok(priceLimited.priceRebalanceBps > 0);
});

test("depth forecasting is precomputed once per quote run and exposed in route analysis", async () => {
  const collector = await readFile(new URL("../lib/collector.ts", import.meta.url), "utf8");
  const run = await readFile(new URL("../lib/quotes/run.ts", import.meta.url), "utf8");
  const api = await readFile(new URL("../app/api/runs/route.ts", import.meta.url), "utf8");
  const page = await readFile(new URL("../app/swap-rank-dashboard.tsx", import.meta.url), "utf8");
  const migration = await readFile(new URL("../drizzle/0005_productive_gertrude_yorkes.sql", import.meta.url), "utf8");
  assert.match(collector, /poolDepthSnapshotFromAssets/);
  assert.match(collector, /INSERT INTO pool_depth_snapshots/);
  assert.match(run, /forecastThorDepth\(request, quotes, poolDepthSnapshot\)/);
  assert.match(api, /depthForecast: parsedDepthForecast/);
  assert.match(page, /Quote performance/);
  assert.match(page, /Depth forecast/);
  assert.match(page, /Counterfactual model/);
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
  assert.match(readme, /30 fixed directed routes/);
  assert.match(layout, /across 30 fixed routes/);
  assert.match(page, /function routeMatchesProtocols/);
  assert.match(page, /routeMatchesAssets\(route, selectedAssets\) && routeMatchesProtocols\(route, selectedProtocols\)/);
  assert.match(page, /activeRoutePartnerCount/);
  assert.match(page, /\["bch", "bnb", "doge", "ltc", "sol", "xrp"\]/);
  for (const symbol of ["bch", "bnb", "doge", "ltc", "sol", "xrp"]) {
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
  assert.match(collector, /new Response\(compressed\)\.arrayBuffer\(\)/);
  assert.match(collector, /Archive upload failed:/);
  assert.match(collector, /status IN \('partial', 'failed'\)/);
  assert.match(worker, /console\.error\("Collector bundle failed"/);
  assert.match(backfill, /CAST\(3600 AS TEXT\)/);
  assert.match(backfill, /CAST\(14400 AS TEXT\)/);
});
