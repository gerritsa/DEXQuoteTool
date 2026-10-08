import assert from "node:assert/strict";
import test from "node:test";
import { findSelectedRoute, reverseRoute, routeDestinationAssets, routeSourceAssets } from "../lib/routes/selection.ts";

const btc = { id: "bitcoin:btc", symbol: "BTC", chain: "bitcoin" };
const eth = { id: "ethereum:eth", symbol: "ETH", chain: "ethereum" };
const usdtEth = { id: "ethereum:usdt", symbol: "USDT", chain: "ethereum" };
const usdtTron = { id: "tron:usdt", symbol: "USDT", chain: "tron" };
const sol = { id: "solana:sol", symbol: "SOL", chain: "solana" };
const pair = (source, destination) => ({ id: `${source.id}__${destination.id}`, source, destination });
const routes = [pair(btc, eth), pair(eth, btc), pair(btc, usdtEth), pair(btc, usdtTron), pair(sol, eth)];

test("source choices include only tracked outgoing assets without duplicates", () => {
  assert.deepEqual(routeSourceAssets(routes), [btc, eth, sol]);
  assert.deepEqual(routeSourceAssets([]), []);
});

test("destination choices follow directed routes and preserve chain identity", () => {
  assert.deepEqual(routeDestinationAssets(routes, btc.id), [eth, usdtEth, usdtTron]);
  assert.deepEqual(routeDestinationAssets(routes, eth.id), [btc]);
  assert.deepEqual(routeDestinationAssets(routes, sol.id), [eth]);
  assert.deepEqual(routeDestinationAssets(routes, usdtEth.id), []);
  assert.deepEqual(routeDestinationAssets(routes, "untracked"), []);
});

test("changing source retains the destination only when the new directed pair is tracked", () => {
  assert.equal(findSelectedRoute(routes, sol.id, eth.id), routes[4]);
  assert.equal(findSelectedRoute(routes, sol.id, usdtEth.id), null);
  assert.equal(findSelectedRoute(routes, btc.id, btc.id), null);
});

test("the direction switch requires the exact reverse route", () => {
  assert.equal(reverseRoute(routes, routes[0]), routes[1]);
  assert.equal(reverseRoute(routes, routes[1]), routes[0]);
  assert.equal(reverseRoute(routes, routes[2]), null);
  assert.equal(reverseRoute(routes, routes[4]), null);
});
