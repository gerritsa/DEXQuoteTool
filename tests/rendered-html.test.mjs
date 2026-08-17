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

test("server-renders the QuoteTool dashboard", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<title>QuoteTool/);
  assert.match(html, /See who wins/);
  assert.doesNotMatch(html, /Real quotes only/);
  assert.match(html, /Best protocol by size/);
  assert.match(html, /\$10K/);
  assert.match(html, /7 days/);
  assert.match(html, /14 days/);
  assert.match(html, /30 days/);
  assert.match(html, /Batch median/);
  assert.match(html, /Execution mode/);
  assert.match(html, /Streaming\/DCA/);
  assert.doesNotMatch(html, /Route set frozen/);
  assert.doesNotMatch(html, /THORChain reference/);
  assert.doesNotMatch(html, /Metadata endpoints/);
  assert.doesNotMatch(html, /Partner status/);
  assert.match(html, /No captured requests yet/);
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
