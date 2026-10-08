import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";

// Match the app's extensionless TS imports when running domain tests in Node.
registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); }
  catch (error) {
    if ((specifier.startsWith(".") || specifier.startsWith("/")) && !/\.[a-z]+$/.test(specifier)) return nextResolve(`${specifier}.ts`, context);
    throw error;
  }
} });
const { decimalUnits, bucketIndex, emptyTotals, addEvent, hourMs, scoreQuotes, volumeProtocols, volumePageBudget, volumePeriods } = await import("../lib/volume/model.ts");
const { normalizeMidgard, normalizeChainflip, normalizeNear, nearTokenMapping, fetchVolumePage, midgardFilterAssets } = await import("../lib/volume/adapters.ts");
const { buildVolumeWindow } = await import("../lib/volume/windows.ts");
const { collectVolume, enqueueVolumeCollection, publishRouteWindows, pruneVolume } = await import("../lib/volume/collector.ts");
const { historicalRoutes } = await import("../lib/routes/catalog.ts");
const { canonicalPublicCacheUrl } = await import("../lib/http-cache.ts");
const route = historicalRoutes()[0];

function action(id = "customer-parent", timestamp = Date.now() - hourMs) {
  return { type: "swap", status: "success", date: `${BigInt(timestamp) * 1_000_000n}`,
    in: [{ txID: id, coins: [{ asset: "BTC.BTC", amount: "1000000" }] }],
    out: [{ coins: [{ asset: "ETH.ETH", amount: "1" }] }],
    metadata: { swap: { inPriceUSD: "60000", txType: "swap" } } };
}

function database() {
  const db = new DatabaseSync(":memory:");
  const d1 = { prepare(sql) {
    let args = [];
    const prepared = { bind(...values) { args = values; return prepared; },
      async all() { return { results: db.prepare(sql).all(...args) }; },
      async first() { return db.prepare(sql).get(...args) ?? null; },
      async run() { const result = db.prepare(sql).run(...args); return { meta: { changes: Number(result.changes) } }; },
    };
    return prepared;
  }, async batch(statements) {
    db.exec("BEGIN");
    try { const result = []; for (const statement of statements) result.push(await statement.run()); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  } };
  return { db, d1 };
}

async function migrated() {
  const result = database();
  result.db.exec(await readFile(new URL("../drizzle/0009_material_true_believers.sql", import.meta.url), "utf8"));
  result.db.exec(await readFile(new URL("../drizzle/0010_young_liz_osborn.sql", import.meta.url), "utf8"));
  result.db.exec(await readFile(new URL("../drizzle/0011_real_mantis.sql", import.meta.url), "utf8"));
  result.db.exec(await readFile(new URL("../drizzle/0012_harsh_xorn.sql", import.meta.url), "utf8"));
  result.db.exec("CREATE TABLE trend_buckets(pair_id TEXT,amount_id TEXT,samples_json TEXT,mode TEXT,bucket_seconds INTEGER,bucket_start TEXT)");
  return result;
}

test("fixed-point buckets have no gaps or overlaps at every boundary", () => {
  for (const [index, amount] of [500, 1000, 10000, 50000, 100000, 500000, 1000000].entries()) {
    const units = decimalUnits(String(amount));
    assert.equal(bucketIndex(units), index);
    assert.equal(bucketIndex(units + 1n), index + 1);
  }
  assert.equal(decimalUnits("1.2e3"), 1_200_000_000n);
  assert.equal(decimalUnits("garbage"), null);
  assert.equal(decimalUnits("-5"), null);
  assert.equal(bucketIndex(0n), -1);
});

test("Midgard uses e8 amounts and executed streaming input, with one parent identity", () => {
  const original = action();
  const event = normalizeMidgard(original);
  assert.equal(event.routeId, route.id); assert.equal(event.usdMicros, "600000000");
  original.metadata.swap.isStreamingSwap = true;
  original.metadata.swap.streamingSwapMeta = { inCoin: { asset: "BTC.BTC", amount: "500000" }, count: "10", quantity: "10" };
  assert.equal(normalizeMidgard(original).usdMicros, "300000000");
  assert.equal(normalizeMidgard(original).id, event.id);
  original.in[0].coins[0].asset = "BTC~BTC";
  assert.equal(normalizeMidgard(original), null);
});

test("Chainflip folds DCA chunks and excludes network fees and fully refunded requests", () => {
  const parent = { nativeId: "42", type: "REGULAR", sourceAsset: "Btc", destinationAsset: "Eth", requestedBlockTimestamp: "2026-10-07T01:00:00Z", completedEventId: "1",
    executedSwaps: { totalCount: 10, aggregates: { sum: { swapInputValueUsd: "510.125" } } } };
  assert.equal(normalizeChainflip(parent).usdMicros, "510125000");
  assert.equal(normalizeChainflip({ ...parent, type: "NETWORK_FEE" }), null);
  assert.equal(normalizeChainflip({ ...parent, executedSwaps: { totalCount: 0 } }), null);
});

test("NEAR identity includes deposit memo and exact chain/token mapping", () => {
  const mapping = nearTokenMapping([{ blockchain: "btc", symbol: "BTC", assetId: "btc" }, { blockchain: "eth", symbol: "ETH", assetId: "eth" }]);
  const swap = { originAsset: "btc", destinationAsset: "eth", depositAddress: "shared", depositMemo: "7", status: "SUCCESS", createdAt: "2026-10-07T01:00:00Z", amountInUsd: "999.123" };
  assert.equal(normalizeNear(swap, mapping).id, "shared:7");
  assert.equal(normalizeNear(swap, mapping).usdMicros, "999123000");
  assert.equal(normalizeNear({ ...swap, depositType: "INTENTS" }, mapping), null);
  assert.equal(normalizeNear({ ...swap, status: "REFUNDED" }, mapping), null);
  assert.equal(normalizeNear({ ...swap, status: "PENDING_DEPOSIT" }, mapping), null);
  const zec = nearTokenMapping([{ blockchain: "zec", symbol: "ZEC", assetId: "zec" }]);
  assert.equal(zec.get("zec"), "ZEC.ZEC");
});

test("window coverage distinguishes unavailable, partial, zero, and fractional quote ties", () => {
  const end = Date.parse("2026-10-07T12:00:00Z");
  const empty = buildVolumeWindow(route.id, 1, end, [], [], []);
  assert.equal(empty.status, "unavailable"); assert.equal(empty.buckets[0].providers[0].available, false);
  const hours = volumeProtocols.flatMap((protocol) => Array.from({ length: 24 }, (_, index) => ({ protocol, hour: end - (index + 1) * hourMs, status: "complete", updatedAt: new Date(end).toISOString() })));
  const scores = scoreQuotes([{ protocol: "thorchain", output: 5 }, { protocol: "maya", output: 5 }]);
  const populated = buildVolumeWindow(route.id, 1, end, [], hours, [{ hour: end - hourMs, scoresJson: JSON.stringify({ "500": scores }) }]);
  assert.equal(populated.status, "complete"); assert.equal(populated.volumeUsd, 0);
  assert.deepEqual(populated.buckets[0].leaders, ["thorchain", "maya"]);
  assert.equal(populated.buckets[0].winRate, 0.5); assert.equal(populated.buckets[0].competingSamples, 1);
  assert.equal(populated.buckets[7].leaders.length, 0);
  assert.equal(buildVolumeWindow(route.id, 7, end, [], hours, []).status, "partial");
  const totals = emptyTotals(); addEvent(totals, { usdMicros: null, pending: false });
  const unknown = buildVolumeWindow(route.id, 1, end, [{ protocol: "thorchain", hour: end - hourMs, totalsJson: JSON.stringify(totals), updatedAt: new Date(end).toISOString() }], hours, []);
  assert.equal(unknown.unpricedSwaps, 1); assert.equal(unknown.volumeUsd, 0);
});

test("Midgard request timestamps are seconds while returned action dates are nanoseconds", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(new URL(url).searchParams.get("fromTimestamp"), "1791320399");
    assert.equal(new URL(url).searchParams.get("timestamp"), "1791324001");
    assert.match(new URL(url).searchParams.get("asset"), /BTC.BTC/);
    assert.ok(new URL(url).searchParams.get("asset").split(",").length <= 4);
    return Response.json({ actions: [], meta: {} });
  };
  try { await fetchVolumePage("thorchain", 1791320400000, 1791324000000, null, {}); }
  finally { globalThis.fetch = original; }
});

test("Midgard filter stays within the API limit and covers every tracked directed route", () => {
  const filter = midgardFilterAssets();
  assert.ok(filter.length <= 4);
  for (const route of historicalRoutes()) assert.ok(filter.includes(route.source.thorAsset) || filter.includes(route.destination.thorAsset), route.id);
});

test("Maya uses single-asset shards because its multi-asset filter requires every asset", async () => {
  const original = globalThis.fetch;
  const queried = [];
  const start = 1791414000000;
  globalThis.fetch = async (url) => {
    const filter = new URL(url).searchParams.get("asset");
    assert.equal(filter.split(",").length, 1);
    queried.push(filter);
    return Response.json({ actions: [action("same-parent", start + 1000)], meta: {} });
  };
  try {
    let cursor = null;
    for (let index = 0; index < midgardFilterAssets().length; index++) {
      const page = await fetchVolumePage("maya", start, start + hourMs, cursor, {});
      assert.equal(page.events[0].id, "same-parent");
      cursor = page.cursor;
    }
    assert.equal(cursor, null);
    assert.deepEqual(queried, midgardFilterAssets());
  } finally { globalThis.fetch = original; }
});

test("Midgard continuation uses its page token instead of a conflicting timestamp", async () => {
  const original = globalThis.fetch;
  const start = 1791414000000;
  try {
    for (const protocol of ["thorchain", "maya"]) {
      let calls = 0;
      globalThis.fetch = async (value) => {
        const url = new URL(value); calls++;
        if (calls === 1) {
          assert.ok(url.searchParams.has("timestamp"));
          return Response.json({ actions: Array.from({ length: 50 }, () => action("parent", start + 1000)), meta: { nextPageToken: "next" } });
        }
        assert.equal(url.searchParams.get("nextPageToken"), "next");
        assert.equal(url.searchParams.has("timestamp"), false);
        assert.equal(url.searchParams.get("fromTimestamp"), protocol === "thorchain" ? String(start / 1000 - 1) : null);
        return Response.json({ actions: [], meta: {} });
      };
      const first = await fetchVolumePage(protocol, start, start + hourMs, null, {});
      await fetchVolumePage(protocol, start, start + hourMs, first.cursor, {});
      assert.equal(calls, 2);
    }
  } finally { globalThis.fetch = original; }
});

test("Maya scans backward from the upper bound and stops a shard at the requested start", async () => {
  const original = globalThis.fetch;
  const start = 1791414000000;
  let calls = 0;
  globalThis.fetch = async (value) => {
    const url = new URL(value); calls++;
    assert.equal(url.searchParams.has("fromTimestamp"), false);
    return Response.json({ actions: Array.from({ length: 50 }, () => action("parent", calls === 1 ? start + 1000 : start - 1000)), meta: { nextPageToken: "next" } });
  };
  try {
    const first = await fetchVolumePage("maya", start, start + hourMs, null, {});
    const older = await fetchVolumePage("maya", start, start + hourMs, first.cursor, {});
    assert.equal(older.events.length, 0);
    assert.deepEqual(JSON.parse(older.cursor), { shard: 1, page: null });
  } finally { globalThis.fetch = original; }
});

test("volume and quote leaders use only the same contiguous hours for every participating provider", () => {
  const end = Date.parse("2026-10-07T12:00:00Z");
  const hours = volumeProtocols.flatMap((protocol) => Array.from({ length: protocol === "maya" ? 2 : 4 }, (_, index) => ({ protocol, hour: end - (index + 1) * hourMs, status: "complete", updatedAt: new Date(end).toISOString() })));
  const rows = volumeProtocols.flatMap((protocol) => Array.from({ length: 4 }, (_, index) => {
    const totals = emptyTotals(); addEvent(totals, { usdMicros: "100000000", pending: false });
    return { protocol, hour: end - (index + 1) * hourMs, totalsJson: JSON.stringify(totals), updatedAt: new Date(end).toISOString() };
  }));
  const quote = (hour, winner) => ({ hour, scoresJson: JSON.stringify({ "500": scoreQuotes([{ protocol: winner, output: 5 }]) }) });
  const result = buildVolumeWindow(route.id, 1, end, rows, hours, [quote(end - hourMs, "thorchain"), quote(end - 3 * hourMs, "near-intents")]);
  assert.equal(result.startAt, new Date(end - 2 * hourMs).toISOString());
  assert.equal(result.endAt, new Date(end).toISOString());
  assert.equal(result.comparison.hours, 2);
  assert.equal(result.volumeUsd, 800);
  assert.ok(result.coverage.every((provider) => provider.hours === 2));
  assert.deepEqual(result.buckets[0].leaders, ["thorchain"]);
  assert.equal(result.buckets[0].samples, 1);
  hours.splice(hours.findIndex((row) => row.protocol === "maya" && row.hour === end - 2 * hourMs), 1);
  assert.equal(buildVolumeWindow(route.id, 1, end, rows, hours, []).comparison.hours, 1);
});

test("unsupported providers do not block a shared route comparison, and missing required providers hide unmatched volume", () => {
  const end = Date.parse("2026-10-07T12:00:00Z");
  const active = ["thorchain", "near-intents"];
  const hours = active.flatMap((protocol) => Array.from({ length: 24 }, (_, index) => ({ protocol, hour: end - (index + 1) * hourMs, status: "complete", updatedAt: new Date(end).toISOString() })));
  const result = buildVolumeWindow(route.id, 1, end, [], hours, [], {}, active);
  assert.equal(result.status, "complete"); assert.equal(result.comparison.hours, 24);
  assert.equal(result.coverage.find((provider) => provider.protocol === "maya").status, "not-applicable");
  const totals = emptyTotals(); addEvent(totals, { usdMicros: "600000000", pending: false });
  const waiting = buildVolumeWindow(route.id, 1, end, [{ protocol: "thorchain", hour: end - hourMs, totalsJson: JSON.stringify(totals), updatedAt: new Date(end).toISOString() }], hours.filter((row) => row.protocol === "thorchain"), [], {}, active);
  assert.equal(waiting.volumeUsd, 0); assert.equal(waiting.startAt, null); assert.equal(waiting.endAt, null);
});

test("collector resumes a committed page after failure and duplicate parents are counted once", async () => {
  const { db, d1 } = await migrated();
  const originalFetch = globalThis.fetch, originalNow = Date.now;
  let time = Date.parse("2026-10-07T12:10:00Z"); Date.now = () => time;
  const queue = [], archives = [];
  const environment = { DB: d1, VOLUME_COLLECTION_ENABLED: "true", VOLUME_QUEUE: { async send(body, options) { queue.push({ body, options }); }, async sendBatch(messages) { queue.push(...messages); } },
    ARCHIVE: { async put(key, stream) { archives.push(key); await new Response(stream).arrayBuffer(); } } };
  try {
    await enqueueVolumeCollection(time, environment);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM volume_routes").get().count, 50);
    const hour = Math.floor(time / hourMs) * hourMs - hourMs;
    let calls = 0;
    globalThis.fetch = async (url) => {
      calls++;
      if (calls === 1) return Response.json({ actions: Array.from({ length: 50 }, () => action("same-parent", hour + 1000)), meta: { nextPageToken: "next" } });
      if (calls === 2) return new Response(null, { status: 503 });
      assert.equal(new URL(url).searchParams.get("nextPageToken"), "next");
      return Response.json({ actions: [], meta: {} });
    };
    await collectVolume("thorchain", environment);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM volume_hourly").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM volume_recent_swaps").get().count, 1);
    time += 61_000;
    await collectVolume("thorchain", environment);
    const total = JSON.parse(db.prepare("SELECT totals_json FROM volume_hourly").get().totals_json);
    assert.equal(total.swaps[1], 1); assert.equal(total.usdMicros[1], "600000000");
    assert.equal(archives.length, 1);
    await publishRouteWindows([route.id], Math.floor(time / hourMs) * hourMs, environment);
    const waiting = JSON.parse(db.prepare("SELECT payload_json FROM route_volume_windows WHERE days = 1").get().payload_json);
    assert.equal(waiting.volumeUsd, 0); assert.equal(waiting.comparison.hours, 0);
    db.prepare("UPDATE volume_feed_hours SET status='complete', updated_at=? WHERE hour=? AND protocol!='thorchain'").run(new Date(time).toISOString(), hour);
    await publishRouteWindows([route.id], Math.floor(time / hourMs) * hourMs, environment);
    const payload = JSON.parse(db.prepare("SELECT payload_json FROM route_volume_windows WHERE days = 1").get().payload_json);
    assert.equal(payload.volumeUsd, 600); assert.equal(payload.status, "partial");
    assert.equal(payload.buckets[1].providers.find((row) => row.protocol === "maya").available, true);
    assert.equal(payload.comparison.hours, 1);
    time += 73 * hourMs;
    await pruneVolume(time, environment);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM volume_recent_swaps").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM volume_hourly").get().count, 1);
    time += 36 * 24 * hourMs;
    await pruneVolume(time, environment);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM volume_hourly").get().count, 0);
  } finally { globalThis.fetch = originalFetch; Date.now = originalNow; db.close(); }
});

test("public volume cache does not multiply with unrelated query parameters", () => {
  const key = canonicalPublicCacheUrl(new Request(`https://example.com/api/route-volume?routeId=${encodeURIComponent(route.id)}&days=7&size=1000&protocols=maya`));
  assert.equal(new URL(key).searchParams.size, 3);
  assert.equal(new URL(key).searchParams.get("days"), "7");
});

test("late successful parent swaps replace the hour rather than add another copy", async () => {
  const { db, d1 } = await migrated();
  const originalFetch = globalThis.fetch, originalNow = Date.now;
  let time = Date.parse("2026-10-07T12:10:00Z"); Date.now = () => time;
  const environment = { DB: d1, VOLUME_COLLECTION_ENABLED: "true", VOLUME_QUEUE: { async send() {}, async sendBatch() {} }, ARCHIVE: { async put() {} } };
  try {
    await enqueueVolumeCollection(time, environment);
    const hour = Math.floor(time / hourMs) * hourMs - hourMs;
    const pending = action("late-parent", hour + 1000); pending.status = "pending";
    globalThis.fetch = async () => Response.json({ actions: [pending], meta: {} });
    await collectVolume("thorchain", environment);
    assert.equal(JSON.parse(db.prepare("SELECT totals_json FROM volume_hourly").get().totals_json).swaps[1], 0);
    db.prepare("UPDATE volume_feed_hours SET status = 'complete', pending = 0 WHERE id != ?").run(`thorchain:${hour}`);
    time += 3 * hourMs + 1000;
    globalThis.fetch = async () => Response.json({ actions: [action("late-parent", hour + 1000)], meta: {} });
    await collectVolume("thorchain", environment);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM volume_hourly").get().count, 1);
    assert.equal(JSON.parse(db.prepare("SELECT totals_json FROM volume_hourly").get().totals_json).swaps[1], 1);
    await collectVolume("thorchain", environment);
    assert.equal(JSON.parse(db.prepare("SELECT totals_json FROM volume_hourly").get().totals_json).swaps[1], 1);
  } finally { globalThis.fetch = originalFetch; Date.now = originalNow; db.close(); }
});

test("daily request budget pauses before contacting a provider", async () => {
  const { db, d1 } = await migrated();
  const originalFetch = globalThis.fetch, originalNow = Date.now;
  const time = Date.parse("2026-10-07T12:10:00Z"); Date.now = () => time;
  let calls = 0;
  const environment = { DB: d1, VOLUME_COLLECTION_ENABLED: "true", VOLUME_DAILY_PAGE_LIMIT: "100", VOLUME_QUEUE: { async send() {}, async sendBatch() {} }, ARCHIVE: { async put() {} } };
  try {
    await enqueueVolumeCollection(time, environment);
    db.prepare("UPDATE volume_ingestion_state SET budget_day = ?, pages_today = 100 WHERE protocol = 'thorchain'").run(Math.floor(time / (24 * hourMs)));
    globalThis.fetch = async () => { calls++; return Response.json({ actions: [], meta: {} }); };
    await collectVolume("thorchain", environment);
    assert.equal(calls, 0);
    assert.match(db.prepare("SELECT last_error FROM volume_ingestion_state WHERE protocol = 'thorchain'").get().last_error, /Daily history request budget/);
    assert.equal(db.prepare("SELECT SUM(failures) AS failures FROM volume_feed_hours").get().failures, 0);
  } finally { globalThis.fetch = originalFetch; Date.now = originalNow; db.close(); }
});

test("a collector that loses its lease cannot commit pages or overwrite the new owner", async () => {
  const { db, d1 } = await migrated();
  const originalFetch = globalThis.fetch, originalNow = Date.now;
  const time = Date.parse("2026-10-07T12:10:00Z"); Date.now = () => time;
  let archives = 0;
  const environment = { DB: d1, VOLUME_COLLECTION_ENABLED: "true", VOLUME_QUEUE: { async send() {}, async sendBatch() {} }, ARCHIVE: { async put() { archives++; } } };
  try {
    await enqueueVolumeCollection(time, environment);
    globalThis.fetch = async () => {
      db.prepare("UPDATE volume_ingestion_state SET lease = 'new-owner' WHERE protocol = 'thorchain'").run();
      return Response.json({ actions: [action("parent", Math.floor(time / hourMs) * hourMs - 1000)], meta: {} });
    };
    await collectVolume("thorchain", environment);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM volume_recent_swaps").get().count, 0);
    assert.equal(db.prepare("SELECT SUM(pages) AS count FROM volume_feed_hours").get().count, 0);
    assert.equal(db.prepare("SELECT lease FROM volume_ingestion_state WHERE protocol = 'thorchain'").get().lease, "new-owner");
    assert.equal(archives, 0);
  } finally { globalThis.fetch = originalFetch; Date.now = originalNow; db.close(); }
});

test("provider temporary storage cap prevents further source requests", async () => {
  const { db, d1 } = await migrated();
  const originalFetch = globalThis.fetch, originalNow = Date.now;
  const time = Date.parse("2026-10-07T12:10:00Z"); Date.now = () => time;
  let calls = 0;
  const environment = { DB: d1, VOLUME_COLLECTION_ENABLED: "true", VOLUME_QUEUE: { async send() {}, async sendBatch() {} }, ARCHIVE: { async put() {} } };
  try {
    await enqueueVolumeCollection(time, environment);
    db.prepare("UPDATE volume_feed_hours SET staged_rows = 100000 WHERE id = (SELECT id FROM volume_feed_hours WHERE protocol = 'thorchain' ORDER BY hour LIMIT 1)").run();
    globalThis.fetch = async () => { calls++; return Response.json({ actions: [], meta: {} }); };
    await collectVolume("thorchain", environment);
    assert.equal(calls, 0);
    assert.match(db.prepare("SELECT last_error FROM volume_ingestion_state WHERE protocol = 'thorchain'").get().last_error, /Provider staging storage budget/);
    assert.equal(db.prepare("SELECT SUM(failures) AS count FROM volume_feed_hours").get().count, 0);
  } finally { globalThis.fetch = originalFetch; Date.now = originalNow; db.close(); }
});

test("an initially empty hour is rechecked for a later funded customer swap", async () => {
  const { db, d1 } = await migrated();
  const originalFetch = globalThis.fetch, originalNow = Date.now;
  let time = Date.parse("2026-10-07T12:10:00Z"); Date.now = () => time;
  const environment = { DB: d1, VOLUME_COLLECTION_ENABLED: "true", VOLUME_QUEUE: { async send() {}, async sendBatch() {} }, ARCHIVE: { async put() {} } };
  try {
    await enqueueVolumeCollection(time, environment);
    const hour = Math.floor(time / hourMs) * hourMs - hourMs;
    globalThis.fetch = async () => Response.json({ actions: [], meta: {} });
    await collectVolume("thorchain", environment);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM volume_hourly").get().count, 0);
    db.prepare("UPDATE volume_feed_hours SET status = 'complete', generation = 4, pending = 0 WHERE id != ?").run(`thorchain:${hour}`);
    time += 3 * hourMs + 1000;
    globalThis.fetch = async () => Response.json({ actions: [action("late-deposit", hour + 1000)], meta: {} });
    await collectVolume("thorchain", environment);
    assert.equal(JSON.parse(db.prepare("SELECT totals_json FROM volume_hourly").get().totals_json).swaps[1], 1);
    assert.equal(db.prepare("SELECT next_attempt FROM volume_feed_hours WHERE id = ?").get(`thorchain:${hour}`).next_attempt, hour + 25 * hourMs);
  } finally { globalThis.fetch = originalFetch; Date.now = originalNow; db.close(); }
});

test("unfinished recent hours preempt an in-progress older backfill without losing its cursor", async () => {
  const { db, d1 } = await migrated();
  const originalFetch = globalThis.fetch, originalNow = Date.now;
  const time = Date.parse("2026-10-08T12:10:00Z"), cutoff = Math.floor(time / hourMs) * hourMs;
  Date.now = () => time;
  const environment = { DB: d1, VOLUME_COLLECTION_ENABLED: "true", VOLUME_QUEUE: { async send() {}, async sendBatch() {} }, ARCHIVE: { async put() {} } };
  try {
    await enqueueVolumeCollection(time, environment);
    const old = `thorchain:${cutoff - 48 * hourMs}`;
    db.prepare("UPDATE volume_feed_hours SET status='running', generation=1, cursor='old-cursor' WHERE id=?").run(old);
    globalThis.fetch = async (value) => {
      const url = new URL(value);
      assert.equal(url.searchParams.get("timestamp"), String(cutoff / 1000 + 1));
      assert.equal(url.searchParams.has("nextPageToken"), false);
      return Response.json({ actions: [], meta: {} });
    };
    await collectVolume("thorchain", environment);
    assert.equal(db.prepare("SELECT status FROM volume_feed_hours WHERE id=?").get(`thorchain:${cutoff - hourMs}`).status, "complete");
    assert.equal(db.prepare("SELECT cursor FROM volume_feed_hours WHERE id=?").get(old).cursor, "old-cursor");
  } finally { globalThis.fetch = originalFetch; Date.now = originalNow; db.close(); }
});

test("background allowance exhaustion leaves the reserved pages available for recent hours", async () => {
  const { db, d1 } = await migrated();
  const originalFetch = globalThis.fetch, originalNow = Date.now;
  const time = Date.parse("2026-10-08T12:10:00Z"), cutoff = Math.floor(time / hourMs) * hourMs;
  Date.now = () => time; let calls = 0;
  const environment = { DB: d1, VOLUME_COLLECTION_ENABLED: "true", VOLUME_DAILY_PAGE_LIMIT: "100", VOLUME_LIVE_PAGE_RESERVE: "50", VOLUME_QUEUE: { async send() {}, async sendBatch() {} }, ARCHIVE: { async put() {} } };
  try {
    await enqueueVolumeCollection(time, environment);
    db.prepare("UPDATE volume_ingestion_state SET budget_day=?, pages_today=50, background_pages_today=50 WHERE protocol='thorchain'").run(Math.floor(time / (24 * hourMs)));
    globalThis.fetch = async () => { calls++; return Response.json({ actions: [], meta: {} }); };
    await collectVolume("thorchain", environment);
    assert.equal(calls, 1);
    const usage = db.prepare("SELECT pages_today, background_pages_today, last_error FROM volume_ingestion_state WHERE protocol='thorchain'").get();
    assert.equal(usage.pages_today, 51); assert.equal(usage.background_pages_today, 50); assert.equal(usage.last_error, null);
    db.prepare("UPDATE volume_feed_hours SET status='complete', generation=4, pending=0 WHERE hour>=?").run(cutoff - 24 * hourMs);
    await collectVolume("thorchain", environment);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = originalFetch; Date.now = originalNow; db.close(); }
});

test("catch-up allowance expires automatically and cannot increase the background budget", () => {
  const config = { VOLUME_DAILY_PAGE_LIMIT: "2000", VOLUME_LIVE_PAGE_RESERVE: "1000", VOLUME_LIVE_CATCHUP_DAY: "2026-10-08", VOLUME_LIVE_CATCHUP_PAGES: "250" };
  const today = volumePageBudget(config, Date.parse("2026-10-08T12:00:00Z"));
  assert.equal(today.liveTotalLimit, 2250); assert.equal(today.backgroundLimit, 1000);
  const tomorrow = volumePageBudget(config, Date.parse("2026-10-09T00:00:00Z"));
  assert.equal(tomorrow.liveTotalLimit, 2000); assert.equal(tomorrow.catchup, 0);
});

test("disabled 30-day volume only seeds seven days while retained history remains available", async () => {
  assert.deepEqual(volumePeriods({ VOLUME_30D_ENABLED: "false" }), [1, 7]);
  assert.deepEqual(volumePeriods({ VOLUME_30D_ENABLED: "true" }), [1, 7, 30]);
  const { db, d1 } = await migrated();
  const time = Date.parse("2026-10-08T12:10:00Z"), cutoff = Math.floor(time / hourMs) * hourMs;
  try {
    db.prepare("INSERT INTO volume_hourly VALUES ('retained',1,'thorchain',?,?,?)").run(cutoff - 20 * 24 * hourMs, JSON.stringify(emptyTotals()), new Date(time).toISOString());
    await enqueueVolumeCollection(time, { DB: d1, VOLUME_COLLECTION_ENABLED: "true", VOLUME_30D_ENABLED: "false", VOLUME_QUEUE: { async sendBatch() {} } });
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM volume_feed_hours").get().count, 4 * 7 * 24);
    assert.equal(db.prepare("SELECT MIN(hour) AS hour FROM volume_feed_hours").get().hour, cutoff - 7 * 24 * hourMs);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM volume_hourly").get().count, 1);
  } finally { db.close(); }
});
