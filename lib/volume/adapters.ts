import { historicalRoutes, type PartnerId } from "../routes/catalog";
import { decimalUnits, type FeedPage, type VolumeEvent } from "./model";

type Json = Record<string, unknown>;
const object = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const routes = historicalRoutes();
const routeByAssets = new Map(routes.map((route) => [`${route.source.thorAsset}|${route.destination.thorAsset}`, route.id]));
const assets = Array.from(new Map(routes.flatMap((route) => [route.source, route.destination]).map((asset) => [asset.thorAsset, asset])).values());

// Select a small endpoint cover. THORChain combines these filters with OR;
// older Maya Midgard requires separate one-asset shards, deduplicated by parent.
export function midgardFilterAssets() {
  let uncovered = [...routes];
  const filter: string[] = [];
  while (uncovered.length && filter.length < 4) {
    const best = assets.map((asset) => ({ asset: asset.thorAsset,
      count: uncovered.filter((route) => route.source.thorAsset === asset.thorAsset || route.destination.thorAsset === asset.thorAsset).length,
    })).sort((left, right) => right.count - left.count)[0];
    if (!best?.count) break;
    filter.push(best.asset);
    uncovered = uncovered.filter((route) => route.source.thorAsset !== best.asset && route.destination.thorAsset !== best.asset);
  }
  if (uncovered.length) throw new FeedError("Tracked routes exceed Midgard's four-asset filter; collection needs disjoint shards", 3600);
  return filter;
}

export class FeedError extends Error {
  retrySeconds: number;
  unauthorized: boolean;
  constructor(message: string, retrySeconds = 60, unauthorized = false) {
    super(message); this.retrySeconds = retrySeconds; this.unauthorized = unauthorized;
  }
}

export type FeedEnvironment = { NEAR_EXPLORER_API_KEY?: string; NEAR_INTENTS_API_KEY?: string };

async function jsonRequest(url: string, init: RequestInit = {}) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(12_000), headers: { accept: "application/json", ...init.headers } });
  if (!response.ok) {
    const seconds = Number(response.headers.get("retry-after"));
    throw new FeedError(`History API returned HTTP ${response.status}`, Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 3600) : 60, response.status === 401 || response.status === 403);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new FeedError("History API returned an empty response");
  const chunks: Uint8Array[] = []; let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 2_000_000) { await reader.cancel(); throw new FeedError("History page exceeded its byte budget"); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

function poolAsset(value: unknown) {
  // Trade assets (~) and synths (/) are internal balances, not L1 routes.
  return typeof value === "string" && value.includes(".") && !/[~/]/.test(value) ? value.toUpperCase() : null;
}

export function normalizeMidgard(value: unknown): VolumeEvent | null {
  const action = object(value);
  if (action.type !== "swap" || !["success", "pending"].includes(String(action.status))) return null;
  const inputs = array(action.in).map(object).filter((tx) => !tx.affiliate);
  const sourceTx = inputs[0];
  if (!sourceTx || inputs.length !== 1) return null;
  const coin = object(array(sourceTx.coins)[0]);
  const source = poolAsset(coin.asset);
  const swap = object(object(action.metadata).swap);
  if (swap.txType && swap.txType !== "swap") return null;
  const destinations = array(action.out).map(object).filter((tx) => !tx.affiliate && !tx.isAffiliate)
    .flatMap((tx) => array(tx.coins).map(object)).map((out) => poolAsset(out.asset))
    .filter((asset): asset is string => !!asset && !!source && routeByAssets.has(`${source}|${asset}`));
  const memoTarget = poolAsset(String(swap.memo ?? "").split(":")[1]);
  const unique = [...new Set(destinations)];
  const destination = memoTarget && source && routeByAssets.has(`${source}|${memoTarget}`) && (!unique.length || unique.includes(memoTarget))
    ? memoTarget : unique.length === 1 ? unique[0] : null;
  if (!source || !destination) return null;
  const routeId = routeByAssets.get(`${source}|${destination}`);
  const id = String(sourceTx.txID ?? "");
  const date = String(action.date ?? "");
  if (!routeId || !id || /^0+$/.test(id) || !/^\d{16,20}$/.test(date)) return null;
  const timestamp = Number(BigInt(date) / 1_000_000n);
  const streamCoin = object(object(swap.streamingSwapMeta).inCoin);
  const amount = swap.isStreamingSwap && poolAsset(streamCoin.asset) === source && decimalUnits(streamCoin.amount, 0)
    ? decimalUnits(streamCoin.amount, 0) : decimalUnits(coin.amount, 0);
  const price = decimalUnits(swap.inPriceUSD, 10);
  // Midgard action amounts use e8 even when the native asset has other decimals.
  const micros = amount && price && price > 0n ? (amount * price + 500_000_000_000n) / 1_000_000_000_000n : null;
  return { id, routeId, timestamp, usdMicros: micros?.toString() ?? null, pending: action.status === "pending" };
}

async function midgardPage(protocol: "thorchain" | "maya", start: number, end: number, cursor: string | null): Promise<FeedPage> {
  const base = protocol === "thorchain" ? "https://gateway.liquify.com/chain/thorchain_midgard/v2/actions" : "https://midgard.mayachain.info/v2/actions";
  const url = new URL(base);
  url.searchParams.set("type", "swap"); url.searchParams.set("limit", "50");
  const filters = midgardFilterAssets();
  const shardCursor = protocol === "maya" && cursor ? JSON.parse(cursor) as { shard: number; page: string | null } : { shard: 0, page: cursor };
  url.searchParams.set("asset", protocol === "maya" ? filters[shardCursor.shard] : filters.join(","));
  // API boundaries are exclusive; widen them, then enforce [start,end) locally.
  // The next-page token already supplies the upper boundary. Midgard rejects
  // a request containing both it and timestamp (or height).
  if (!shardCursor.page) url.searchParams.set("timestamp", String(Math.floor(end / 1000) + 1));
  // Maya's legacy fromTimestamp path does not return the requested time range.
  // Scan backwards from the upper bound and stop locally at the lower bound.
  if (protocol === "thorchain") url.searchParams.set("fromTimestamp", String(Math.floor(start / 1000) - 1));
  if (shardCursor.page) url.searchParams.set("nextPageToken", shardCursor.page);
  const body = object(await jsonRequest(url.toString()));
  if (!Array.isArray(body.actions) || body.actions.length > 50) throw new FeedError("Midgard history schema changed");
  const actions = body.actions;
  const reachedStart = protocol === "maya" && actions.some((value) => {
    const date = object(value).date;
    return typeof date === "string" && /^\d{16,20}$/.test(date) && Number(BigInt(date) / 1_000_000n) < start;
  });
  const events = actions.map(normalizeMidgard).filter((event): event is VolumeEvent => !!event && event.timestamp >= start && event.timestamp < end);
  const next = object(body.meta).nextPageToken;
  const nextPage = !reachedStart && actions.length === 50 && next && next !== "0" ? String(next) : null;
  const nextCursor = protocol === "maya" ? nextPage ? JSON.stringify({ shard: shardCursor.shard, page: nextPage })
    : shardCursor.shard + 1 < filters.length ? JSON.stringify({ shard: shardCursor.shard + 1, page: null }) : null : nextPage;
  if (nextCursor && nextCursor === cursor) throw new FeedError("Midgard history cursor did not advance");
  return { events, cursor: nextCursor, pending: events.filter((event) => event.pending).length, records: actions.length };
}

const chainflipAssets: Record<string, string> = {
  Btc: "BTC.BTC", Eth: "ETH.ETH", Sol: "SOL.SOL", Trx: "TRON.TRX",
  Usdc: "ETH.USDC-0XA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48",
  Usdt: "ETH.USDT-0XDAC17F958D2EE523A2206206994597C13D831EC7",
  TrxUsdt: "TRON.USDT-TR7NHQJEKQXGTCI8Q8ZY4PL8OTSZGJLJ6T",
};

// Verified against the public explorer processor schema, October 2026.
export const chainflipVolumeQuery = `query RouteVolume($start: Datetime!, $end: Datetime!, $after: Cursor) {
  allSwapRequests(first: 100, after: $after, orderBy: ID_ASC, filter: {
    type: {equalTo: REGULAR}, requestedBlockTimestamp: {greaterThanOrEqualTo: $start, lessThan: $end}
  }) {
    nodes { nativeId type sourceAsset destinationAsset requestedBlockTimestamp completedEventId
      executedSwaps: swapsBySwapRequestId(filter: {swapExecutedEventId: {isNull: false}, type: {notEqualTo: GAS}}) {
        totalCount aggregates { sum { swapInputValueUsd } }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

export function normalizeChainflip(value: unknown): VolumeEvent | null {
  const swap = object(value);
  if (swap.type !== "REGULAR") return null;
  const routeId = routeByAssets.get(`${chainflipAssets[String(swap.sourceAsset)]}|${chainflipAssets[String(swap.destinationAsset)]}`);
  if (!routeId || !swap.nativeId) return null;
  if (swap.completedEventId && object(swap.executedSwaps).totalCount === 0) return null;
  const usd = object(object(object(swap.executedSwaps).aggregates).sum).swapInputValueUsd;
  const micros = decimalUnits(usd);
  return { id: String(swap.nativeId), routeId, timestamp: Date.parse(String(swap.requestedBlockTimestamp)),
    usdMicros: micros?.toString() ?? null, pending: !swap.completedEventId };
}

async function chainflipPage(start: number, end: number, cursor: string | null): Promise<FeedPage> {
  const body = object(await jsonRequest("https://explorer-service-processor.chainflip.io/graphql", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: chainflipVolumeQuery, variables: { start: new Date(start).toISOString(), end: new Date(end).toISOString(), after: cursor } }),
  }));
  if (body.errors) throw new FeedError("Chainflip history query rejected; verify the explorer schema");
  const connection = object(object(body.data).allSwapRequests);
  if (!Array.isArray(connection.nodes) || connection.nodes.length > 100) throw new FeedError("Chainflip history schema changed");
  const events = connection.nodes.map(normalizeChainflip).filter((event): event is VolumeEvent => !!event && event.timestamp >= start && event.timestamp < end);
  const page = object(connection.pageInfo);
  const next = page.hasNextPage && page.endCursor ? String(page.endCursor) : null;
  if (next === cursor && next) throw new FeedError("Chainflip history cursor did not advance");
  return { events, cursor: next, pending: events.filter((event) => event.pending).length, records: connection.nodes.length };
}

let tokenCache: { expires: number; mapping: Map<string, string> } | undefined;
const chainAliases: Record<string, string> = { btc: "bitcoin", eth: "ethereum", solana: "sol", litecoin: "ltc", bitcoincash: "bch", binance: "bsc", zec: "zcash" };
function tokenKey(chain: string, symbol: string, contract: unknown) {
  const normalized = chainAliases[chain.toLowerCase()] ?? chain.toLowerCase();
  return `${normalized}:${typeof contract === "string" && contract ? contract.toLowerCase() : `native:${symbol.toLowerCase()}`}`;
}

export function nearTokenMapping(tokens: unknown[]) {
  const assetKeys = new Map(assets.map((asset) => [tokenKey(asset.chain, asset.symbol, asset.thorAsset.includes("-") ? asset.thorAsset.split("-")[1] : null), asset.thorAsset]));
  const result = new Map<string, string>();
  for (const value of tokens) {
    const token = object(value);
    const thorAsset = assetKeys.get(tokenKey(String(token.blockchain ?? ""), String(token.symbol ?? ""), token.contractAddress));
    if (thorAsset && typeof token.assetId === "string") result.set(token.assetId, thorAsset);
  }
  return result;
}

export function normalizeNear(value: unknown, mapping: Map<string, string>): VolumeEvent | null {
  const swap = object(value);
  if (!["SUCCESS", "PROCESSING", "INCOMPLETE_DEPOSIT"].includes(String(swap.status))) return null;
  // Internal/confidential balance movements are outside the external route scope.
  if (swap.depositType && swap.depositType !== "ORIGIN_CHAIN") return null;
  if (swap.recipientType && swap.recipientType !== "DESTINATION_CHAIN") return null;
  const routeId = routeByAssets.get(`${mapping.get(String(swap.originAsset))}|${mapping.get(String(swap.destinationAsset))}`);
  if (!routeId || !swap.depositAddress) return null;
  const micros = decimalUnits(swap.amountInUsd);
  return { id: `${String(swap.depositAddress)}:${String(swap.depositMemo ?? "")}`, routeId,
    timestamp: Date.parse(String(swap.createdAt)), usdMicros: micros?.toString() ?? null, pending: swap.status !== "SUCCESS" };
}

async function nearPage(start: number, end: number, cursor: string | null, environment: FeedEnvironment): Promise<FeedPage> {
  const key = environment.NEAR_EXPLORER_API_KEY;
  if (!key) throw new FeedError("NEAR Explorer partner token is not configured", 3600, true);
  if (!tokenCache || tokenCache.expires < Date.now()) {
    const tokens = await jsonRequest("https://1click.chaindefuser.com/v0/tokens");
    if (!Array.isArray(tokens)) throw new FeedError("NEAR token catalog schema changed");
    tokenCache = { mapping: nearTokenMapping(tokens), expires: Date.now() + 3_600_000 };
  }
  const url = new URL("https://explorer.near-intents.org/api/v0/transactions");
  url.searchParams.set("numberOfTransactions", "250");
  url.searchParams.set("startTimestamp", new Date(start - 1).toISOString());
  url.searchParams.set("endTimestamp", new Date(end).toISOString());
  // Unfunded quote requests dominate this feed and are not customer swaps.
  // Hourly reconciliation catches later deposits without scanning every quote.
  url.searchParams.set("statuses", "SUCCESS,PROCESSING,INCOMPLETE_DEPOSIT");
  if (cursor) {
    const [address, memo] = JSON.parse(cursor) as [string, string | null];
    url.searchParams.set("lastDepositAddress", address);
    if (memo !== null) url.searchParams.set("lastDepositMemo", memo);
  }
  const body = await jsonRequest(url.toString(), { headers: { Authorization: `Bearer ${key}` } });
  if (!Array.isArray(body) || body.length > 250) throw new FeedError("NEAR history schema changed");
  const events = body.map((swap) => normalizeNear(swap, tokenCache!.mapping)).filter((event): event is VolumeEvent => !!event && event.timestamp >= start && event.timestamp < end);
  const last = object(body.at(-1));
  const next = body.length === 250 && last.depositAddress ? JSON.stringify([last.depositAddress, last.depositMemo ?? null]) : null;
  if (next && next === cursor) throw new FeedError("NEAR history cursor did not advance");
  return { events, cursor: next, pending: events.filter((event) => event.pending).length, records: body.length };
}

export function fetchVolumePage(protocol: PartnerId, start: number, end: number, cursor: string | null, environment: FeedEnvironment) {
  if (protocol === "thorchain" || protocol === "maya") return midgardPage(protocol, start, end, cursor);
  if (protocol === "chainflip") return chainflipPage(start, end, cursor);
  return nearPage(start, end, cursor, environment);
}
