import assert from "node:assert/strict";
import test from "node:test";

async function render(path = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(new Request(`http://localhost${path}`, { headers: { accept: "text/html" } }), {
    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
  }, { waitUntil() {}, passThroughOnException() {} });
}

test("server-renders the DEX Quote Tool dashboard", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<title>DEX Quote Tool/);
  assert.match(html, /href="\/favicon\.svg"/);
  assert.doesNotMatch(html, /See who wins/);
  assert.doesNotMatch(html, /Cross-chain quote benchmark/);
  assert.doesNotMatch(html, /Thirty fixed THORChain routes/);
  assert.doesNotMatch(html, /Now uses the latest synchronized/);
  assert.doesNotMatch(html, /Real quotes only/);
  assert.match(html, /Best protocol by size/);
  assert.match(html, /\$500/);
  assert.doesNotMatch(html, />\$10</);
  assert.doesNotMatch(html, />\$100</);
  assert.match(html, /\$10K/);
  assert.match(html, /7 days/);
  assert.match(html, /14 days/);
  assert.match(html, /30 days/);
  assert.match(html, /Latest check/);
  assert.match(html, /Batch median/);
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
  assert.doesNotMatch(html, /Search 30 fixed routes/);
  assert.doesNotMatch(html, /30 fixed routes shown/);
  assert.doesNotMatch(html, /Direction is treated separately/);
  assert.doesNotMatch(html, /colour strip/);
  assert.doesNotMatch(html, /Route set frozen/);
  assert.doesNotMatch(html, /THORChain reference/);
  assert.doesNotMatch(html, /Metadata endpoints/);
  assert.doesNotMatch(html, /Partner status/);
  assert.match(html, /Route analysis/);
  assert.match(html, /Latest quotes/);
  assert.doesNotMatch(html, />Exact input</);
  assert.doesNotMatch(html, /Run \$.*test/);
  assert.doesNotMatch(html, /A complete audit trail/);
  assert.doesNotMatch(html, /THORChain assets/);
  assert.doesNotMatch(html, /Illustrative preview values/);
  assert.doesNotMatch(html, /codex-preview/);
  assert.doesNotMatch(html, /react-loading-skeleton/);
});

test("server-renders the overnight collector", async () => {
  const response = await render("/collector");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Full quote sweep/);
  assert.match(html, /Run full sweep/);
});
