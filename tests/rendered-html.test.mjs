import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render(path = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(new Request(`http://localhost${path}`, { headers: { accept: "text/html" } }), {
    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
  }, { waitUntil() {}, passThroughOnException() {} });
}

test("server-renders the SwapRank dashboard", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<title>SwapRank/);
  assert.match(html, /href="\/favicon\.svg"/);
  assert.match(html, /DEX swap quotes,/);
  assert.match(html, /compared by size/);
  assert.match(html, /Switch to light mode/);
  assert.match(html, /\$500/);
  assert.doesNotMatch(html, />\$10</);
  assert.doesNotMatch(html, />\$100</);
  assert.match(html, /\$10K/);
  assert.match(html, /7 days/);
  assert.match(html, /14 days/);
  assert.match(html, /30 days/);
  assert.match(html, /Latest check/);
  assert.match(html, /Win share ranks the leader/);
  assert.match(html, /exact ties split it equally/);
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
  assert.match(html, /Route analysis/);
  assert.match(html, /Latest quotes/);
  assert.doesNotMatch(html, />Exact input</);
  assert.doesNotMatch(html, /Run \$.*test/);
  assert.doesNotMatch(html, /Real requests\. Exact sizes\. Explainable winners\./);
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
