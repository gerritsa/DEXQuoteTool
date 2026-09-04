export type PartnerId = "thorchain" | "chainflip" | "near-intents" | "maya";

type ThorPool = {
  asset: string;
  status: string;
  assetPriceUSD?: string;
  nativeDecimal?: string;
  assetDepth?: string;
  runeDepth?: string;
  liquidityInUSD?: string;
};
type NearToken = { assetId: string; blockchain: string; symbol: string; contractAddress?: string | null; decimals: number };
type ChainflipNetworkInfo = {
  assets: Array<{
    asset: string;
    egressEnabled: boolean;
    vaultSwapDepositsEnabled: boolean;
    depositChannelDepositsEnabled: boolean;
    depositChannelCreationEnabled: boolean;
  }>;
};

type ChainflipAssetDefinition = {
  chainflipId: string;
  chain: string;
  symbol: string;
  contractAddress?: string;
};

export type CatalogAsset = {
  id: string;
  label: string;
  chain: string;
  symbol: string;
  thorAsset: string;
  priceUsd: number | null;
  decimals: number;
  thorPoolDepth?: { asset: string; assetDepth: string; runeDepth: string; liquidityUsd: number };
  support: Record<PartnerId, { source: boolean; destination: boolean; assetId?: string }>;
};

export type CatalogRoute = {
  id: string;
  source: CatalogAsset;
  destination: CatalogAsset;
  partners: PartnerId[];
};

export type CatalogResult = {
  assets: CatalogAsset[];
  refreshedAt: string | null;
  source: "live" | "stored" | "static";
  warning?: string;
};

type CatalogStateRow = {
  assetsJson: string | null;
  refreshedAt: string | null;
};

type CatalogSourceId = "thorchain" | "near-intents" | "chainflip";
type CatalogSourcePayload = ThorPool[] | NearToken[] | ChainflipNetworkInfo;
type CatalogSourceRow = {
  source: CatalogSourceId;
  payloadJson: string | null;
  refreshedAt: string | null;
};
type StoredCatalogSource = {
  payload: CatalogSourcePayload | null;
  refreshedAt: string | null;
};

type CatalogOptions = {
  d1?: D1Database;
  allowStale?: boolean;
  allowStatic?: boolean;
  maxStaleMs?: number;
};

const THOR_MIDGARD_POOLS = "https://gateway.liquify.com/chain/thorchain_midgard/v2/pools";
const NEAR_TOKENS = "https://1click.chaindefuser.com/v0/tokens";
const CHAINFLIP_NETWORK_INFO = "https://chainflip-swap.chainflip.io/api/networkInfo";

// Chain and contract identity comes from Chainflip SDK 2.2.1. The network-info
// response below determines whether each asset is currently enabled.
const CHAINFLIP_ASSETS: ChainflipAssetDefinition[] = [
  { chainflipId: "Usdc", chain: "Ethereum", symbol: "USDC", contractAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
  { chainflipId: "Eth", chain: "Ethereum", symbol: "ETH" },
  { chainflipId: "Btc", chain: "Bitcoin", symbol: "BTC" },
  { chainflipId: "Sol", chain: "Solana", symbol: "SOL" },
  { chainflipId: "TrxUsdt", chain: "Tron", symbol: "USDT", contractAddress: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t" },
  { chainflipId: "Usdt", chain: "Ethereum", symbol: "USDT", contractAddress: "0xdAC17F958D2ee523a2206206994597C13D831ec7" },
  { chainflipId: "Trx", chain: "Tron", symbol: "TRX" },
];

const chainAliases: Record<string, string> = {
  BTC: "bitcoin", Bitcoin: "bitcoin", btc: "bitcoin",
  ETH: "ethereum", Ethereum: "ethereum", eth: "ethereum",
  AVAX: "avalanche", avax: "avalanche",
  SOL: "sol", Solana: "sol", sol: "sol",
  TRON: "tron", Tron: "tron", tron: "tron",
};

const nativeDecimalFallbacks: Record<string, number> = {
  "SOL.SOL": 9,
};

function normalizeChain(chain: string) {
  return chainAliases[chain] ?? chain.toLowerCase();
}

function canonicalAsset(chain: string, symbol: string, contract?: string | null) {
  return `${normalizeChain(chain)}:${contract ? contract.toLowerCase() : `native:${symbol.toLowerCase()}`}`;
}

function parsePoolAsset(asset: string) {
  const separator = asset.indexOf(".");
  const chain = asset.slice(0, separator);
  const rest = asset.slice(separator + 1);
  const contractSeparator = rest.indexOf("-");
  const symbol = contractSeparator === -1 ? rest : rest.slice(0, contractSeparator);
  const contract = contractSeparator === -1 ? null : rest.slice(contractSeparator + 1);
  return { id: canonicalAsset(chain, symbol, contract), chain: normalizeChain(chain), symbol, contract };
}

async function fetchJson<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { accept: "application/json", ...headers } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

const liveCatalogTtlMs = 5 * 60_000;
// A provider catalog outage should not erase several hours of benchmark
// coverage. The stored catalog contains the last known asset IDs and route
// support flags, which remain safe to use while the provider recovers.
export const benchmarkCatalogGraceMs = 6 * 60 * 60_000;
let cache: { expiresAt: number; value: CatalogResult } | undefined;

function buildCatalog(thorPools: ThorPool[], near: NearToken[], chainflipNetworkInfo: ChainflipNetworkInfo) {
  const chainflipNetworkAssets = chainflipNetworkInfo.assets;

  const nearAssets = new Map(near.map((asset) => [canonicalAsset(asset.blockchain, asset.symbol, asset.contractAddress), asset.assetId]));
  const chainflipSupport = new Map(chainflipNetworkAssets.map((asset) => [asset.asset, asset]));
  const cfSourceAssets = new Map(CHAINFLIP_ASSETS.flatMap((asset) => {
    const status = chainflipSupport.get(asset.chainflipId);
    const enabled = status?.depositChannelCreationEnabled && status.depositChannelDepositsEnabled && status.vaultSwapDepositsEnabled;
    return enabled ? [[canonicalAsset(asset.chain, asset.symbol, asset.contractAddress), `${asset.chain}:${asset.symbol}`] as const] : [];
  }));
  const cfDestinationAssets = new Map(CHAINFLIP_ASSETS.flatMap((asset) => {
    const status = chainflipSupport.get(asset.chainflipId);
    return status?.egressEnabled ? [[canonicalAsset(asset.chain, asset.symbol, asset.contractAddress), `${asset.chain}:${asset.symbol}`] as const] : [];
  }));

  const availableThorPools = thorPools.filter((pool) => pool.status.toLowerCase() === "available" && fixedThorAssets.has(pool.asset));

  const assets: CatalogAsset[] = availableThorPools.map((pool) => {
    const parsed = parsePoolAsset(pool.asset);
    const reportedDecimals = Number(pool.nativeDecimal ?? NaN);
    const cfSource = cfSourceAssets.get(parsed.id);
    const cfDestination = cfDestinationAssets.get(parsed.id);
    const nearAsset = nearAssets.get(parsed.id);
    const assetDepth = pool.assetDepth && /^\d+$/.test(pool.assetDepth) ? pool.assetDepth : null;
    const runeDepth = pool.runeDepth && /^\d+$/.test(pool.runeDepth) ? pool.runeDepth : null;
    const liquidityUsd = Number(pool.liquidityInUSD);
    return {
      id: parsed.id,
      label: `${parsed.symbol} · ${parsed.chain}`,
      chain: parsed.chain,
      symbol: parsed.symbol,
      thorAsset: pool.asset,
      priceUsd: pool.assetPriceUSD ? Number(pool.assetPriceUSD) : null,
      decimals: Number.isInteger(reportedDecimals) && reportedDecimals >= 0
        ? reportedDecimals
        : nativeDecimalFallbacks[pool.asset] ?? 8,
      ...(assetDepth && runeDepth && Number.isFinite(liquidityUsd) && liquidityUsd > 0
        ? { thorPoolDepth: { asset: pool.asset, assetDepth, runeDepth, liquidityUsd } }
        : {}),
      support: {
        thorchain: { source: true, destination: true, assetId: pool.asset },
        chainflip: { source: Boolean(cfSource), destination: Boolean(cfDestination), assetId: cfSource ?? cfDestination },
        "near-intents": { source: Boolean(nearAsset), destination: Boolean(nearAsset), assetId: nearAsset },
        maya: { source: false, destination: false },
      },
    };
  }).sort((a, b) => a.label.localeCompare(b.label));

  return assets;
}

function parseSourcePayload(source: CatalogSourceId, value: string | null): CatalogSourcePayload | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (source === "chainflip") {
      return parsed && typeof parsed === "object" && Array.isArray((parsed as ChainflipNetworkInfo).assets)
        ? parsed as ChainflipNetworkInfo
        : null;
    }
    return Array.isArray(parsed) ? parsed as ThorPool[] | NearToken[] : null;
  } catch {
    return null;
  }
}

async function loadStoredCatalogSources(d1: D1Database | undefined) {
  if (!d1) return new Map<CatalogSourceId, StoredCatalogSource>();
  try {
    const result = await d1.prepare(`
      SELECT source, payload_json AS payloadJson, refreshed_at AS refreshedAt
      FROM catalog_sources
    `).all<CatalogSourceRow>();
    return new Map(result.results.map((row) => [row.source, {
      payload: parseSourcePayload(row.source, row.payloadJson),
      refreshedAt: row.refreshedAt,
    }] as const));
  } catch (error) {
    console.warn("Unable to load stored catalog sources", error);
    return new Map<CatalogSourceId, StoredCatalogSource>();
  }
}

async function storeCatalogSourceAttempt(
  d1: D1Database | undefined,
  source: CatalogSourceId,
  payload: CatalogSourcePayload | null,
  error: string | null,
  attemptedAt: string,
) {
  if (!d1) return;
  try {
    if (payload) {
      await d1.prepare(`
        INSERT INTO catalog_sources (source, payload_json, refreshed_at, last_attempt_at, last_error)
        VALUES (?, ?, ?, ?, NULL)
        ON CONFLICT(source) DO UPDATE SET
          payload_json = excluded.payload_json,
          refreshed_at = excluded.refreshed_at,
          last_attempt_at = excluded.last_attempt_at,
          last_error = NULL
      `).bind(source, JSON.stringify(payload), attemptedAt, attemptedAt).run();
      return;
    }
    await d1.prepare(`
      INSERT INTO catalog_sources (source, payload_json, refreshed_at, last_attempt_at, last_error)
      VALUES (?, NULL, NULL, ?, ?)
      ON CONFLICT(source) DO UPDATE SET
        last_attempt_at = excluded.last_attempt_at,
        last_error = excluded.last_error
    `).bind(source, attemptedAt, error).run();
  } catch (storageError) {
    console.warn("Unable to persist catalog source state", { source, storageError });
  }
}

function sourceError(source: CatalogSourceId, reason: unknown) {
  const labels: Record<CatalogSourceId, string> = {
    thorchain: "THORChain catalog unavailable",
    "near-intents": "NEAR Intents catalog unavailable",
    chainflip: "Chainflip catalog unavailable",
  };
  return `${labels[source]}: ${reason}`;
}

function sourcePayload(source: CatalogSourceId, value: CatalogSourcePayload): CatalogSourcePayload {
  if (source === "thorchain") return value as ThorPool[];
  if (source === "near-intents") return value as NearToken[];
  return value as ChainflipNetworkInfo;
}

function parseStoredAssets(value: string | null) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed as CatalogAsset[] : null;
  } catch {
    return null;
  }
}

async function storeCatalogAttempt(d1: D1Database | undefined, assets: CatalogAsset[] | null, error: string | null, attemptedAt: string) {
  if (!d1) return;
  try {
    if (assets) {
      await d1.prepare(`
        INSERT INTO catalog_state (id, assets_json, refreshed_at, last_attempt_at, last_error)
        VALUES ('primary', ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          assets_json = excluded.assets_json,
          refreshed_at = excluded.refreshed_at,
          last_attempt_at = excluded.last_attempt_at,
          last_error = excluded.last_error
      `).bind(JSON.stringify(assets), attemptedAt, attemptedAt, error).run();
      return;
    }
    await d1.prepare(`
      INSERT INTO catalog_state (id, assets_json, refreshed_at, last_attempt_at, last_error)
      VALUES ('primary', NULL, NULL, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        last_attempt_at = excluded.last_attempt_at,
        last_error = excluded.last_error
    `).bind(attemptedAt, error).run();
  } catch (storageError) {
    console.warn("Unable to persist route catalog state", storageError);
  }
}

async function loadStoredCatalog(d1: D1Database | undefined) {
  if (!d1) return null;
  try {
    const row = await d1.prepare(`
      SELECT assets_json AS assetsJson, refreshed_at AS refreshedAt
      FROM catalog_state WHERE id = 'primary'
    `).first<CatalogStateRow>();
    const assets = parseStoredAssets(row?.assetsJson ?? null);
    return assets && row?.refreshedAt ? { assets, refreshedAt: row.refreshedAt } : null;
  } catch (storageError) {
    console.warn("Unable to load stored route catalog", storageError);
    return null;
  }
}

export async function getCatalog(options: CatalogOptions = {}): Promise<CatalogResult> {
  if (cache && cache.expiresAt > Date.now()) return cache.value;
  const attemptedAt = new Date().toISOString();
  const maxStaleMs = options.maxStaleMs ?? benchmarkCatalogGraceMs;
  const storedAggregate = await loadStoredCatalog(options.d1);
  const storedAggregateAgeMs = storedAggregate ? Date.now() - new Date(storedAggregate.refreshedAt).getTime() : Infinity;
  const storedSources = await loadStoredCatalogSources(options.d1);
  const [thorResult, nearResult, chainflipResult] = await Promise.allSettled([
    fetchJson<ThorPool[]>(THOR_MIDGARD_POOLS),
    fetchJson<NearToken[]>(NEAR_TOKENS),
    fetchJson<ChainflipNetworkInfo>(CHAINFLIP_NETWORK_INFO, { "X-Chainflip-Sdk-Version": "2.2.1" }),
  ]);
  const sourceResults = [
    { id: "thorchain" as const, result: thorResult },
    { id: "near-intents" as const, result: nearResult },
    { id: "chainflip" as const, result: chainflipResult },
  ];
  const warnings: string[] = [];
  const selected: Partial<Record<CatalogSourceId, CatalogSourcePayload>> = {};

  for (const { id, result } of sourceResults) {
    if (result.status === "fulfilled") {
      selected[id] = sourcePayload(id, result.value);
      await storeCatalogSourceAttempt(options.d1, id, sourcePayload(id, result.value), null, attemptedAt);
      continue;
    }

    const message = sourceError(id, result.reason);
    await storeCatalogSourceAttempt(options.d1, id, null, message, attemptedAt);
    const stored = storedSources.get(id);
    const storedAgeMs = stored?.refreshedAt ? Date.now() - new Date(stored.refreshedAt).getTime() : Infinity;
    if (options.allowStale && stored?.payload && storedAgeMs <= maxStaleMs) {
      selected[id] = stored.payload;
      warnings.push(`${message}; using the last known ${id} catalog`);
      continue;
    }

    // THORChain defines the fixed route universe. If its source is not
    // available and no per-source snapshot exists, the old combined catalog
    // is the only safe route definition to use.
    if (id === "thorchain") {
      if (options.allowStale && storedAggregate && storedAggregateAgeMs <= maxStaleMs) {
        const value: CatalogResult = { ...storedAggregate, source: "stored", warning: message };
        cache = { value, expiresAt: Date.now() + liveCatalogTtlMs };
        await storeCatalogAttempt(options.d1, storedAggregate.assets, message, attemptedAt);
        return value;
      }
      if (options.allowStatic) {
        const value: CatalogResult = { assets: staticCatalogAssets(), refreshedAt: null, source: "static", warning: message };
        cache = { value, expiresAt: Date.now() + liveCatalogTtlMs };
        await storeCatalogAttempt(options.d1, null, message, attemptedAt);
        return value;
      }
      await storeCatalogAttempt(options.d1, null, message, attemptedAt);
      throw new Error(message);
    }

    if (!options.allowStale) {
      await storeCatalogAttempt(options.d1, null, message, attemptedAt);
      throw new Error(message);
    }

    // A missing secondary catalog only disables that provider's routes. The
    // other catalogs can still produce valid routes and quote requests.
    selected[id] = id === "near-intents" ? [] : { assets: [] };
    warnings.push(`${message}; ${id} routes are temporarily unavailable`);
  }

  const assets = buildCatalog(
    selected.thorchain as ThorPool[],
    selected["near-intents"] as NearToken[],
    selected.chainflip as ChainflipNetworkInfo,
  );
  if (!assets.length) {
    const message = warnings.join("; ") || "No supported route assets are available";
    await storeCatalogAttempt(options.d1, null, message, attemptedAt);
    if (options.allowStatic) {
      const value: CatalogResult = { assets: staticCatalogAssets(), refreshedAt: null, source: "static", warning: message };
      cache = { value, expiresAt: Date.now() + liveCatalogTtlMs };
      return value;
    }
    throw new Error(message);
  }
  const warning = warnings.length ? warnings.join("; ") : null;
  const value: CatalogResult = { assets, refreshedAt: attemptedAt, source: warning ? "stored" : "live", ...(warning ? { warning } : {}) };
  cache = { value, expiresAt: Date.now() + liveCatalogTtlMs };
  await storeCatalogAttempt(options.d1, assets, warning, attemptedAt);
  return value;
}

const fixedThorAssetPairs: Array<[string, string]> = [
  ["BTC.BTC", "ETH.ETH"],
  ["ETH.ETH", "BTC.BTC"],
  ["BTC.BTC", "ETH.USDC-0XA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48"],
  ["ETH.USDC-0XA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48", "BTC.BTC"],
  ["BTC.BTC", "TRON.USDT-TR7NHQJEKQXGTCI8Q8ZY4PL8OTSZGJLJ6T"],
  ["TRON.USDT-TR7NHQJEKQXGTCI8Q8ZY4PL8OTSZGJLJ6T", "BTC.BTC"],
  ["BTC.BTC", "ETH.USDT-0XDAC17F958D2EE523A2206206994597C13D831EC7"],
  ["ETH.USDT-0XDAC17F958D2EE523A2206206994597C13D831EC7", "BTC.BTC"],
  ["ETH.ETH", "ETH.USDC-0XA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48"],
  ["ETH.USDC-0XA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48", "ETH.ETH"],
  ["ETH.ETH", "TRON.USDT-TR7NHQJEKQXGTCI8Q8ZY4PL8OTSZGJLJ6T"],
  ["TRON.USDT-TR7NHQJEKQXGTCI8Q8ZY4PL8OTSZGJLJ6T", "ETH.ETH"],
  ["ETH.ETH", "ETH.USDT-0XDAC17F958D2EE523A2206206994597C13D831EC7"],
  ["ETH.USDT-0XDAC17F958D2EE523A2206206994597C13D831EC7", "ETH.ETH"],
  ["BTC.BTC", "LTC.LTC"],
  ["LTC.LTC", "BTC.BTC"],
  ["BTC.BTC", "BSC.BNB"],
  ["BSC.BNB", "BTC.BTC"],
  ["BTC.BTC", "BCH.BCH"],
  ["BCH.BCH", "BTC.BTC"],
  ["BTC.BTC", "XRP.XRP"],
  ["XRP.XRP", "BTC.BTC"],
  ["BTC.BTC", "DOGE.DOGE"],
  ["DOGE.DOGE", "BTC.BTC"],
  ["BTC.BTC", "SOL.SOL"],
  ["SOL.SOL", "BTC.BTC"],
  ["BTC.BTC", "TRON.TRX"],
  ["TRON.TRX", "BTC.BTC"],
  ["ETH.ETH", "LTC.LTC"],
  ["LTC.LTC", "ETH.ETH"],
];
const fixedThorAssets = new Set(fixedThorAssetPairs.flat());
export const fixedThorRouteCount = fixedThorAssetPairs.length;

const staticAssetDefinitions: Array<{
  thorAsset: string;
  chain: string;
  symbol: string;
  decimals: number;
  chainflipAssetId?: string;
}> = [
  { thorAsset: "BTC.BTC", chain: "bitcoin", symbol: "BTC", decimals: 8, chainflipAssetId: "Bitcoin:BTC" },
  { thorAsset: "ETH.ETH", chain: "ethereum", symbol: "ETH", decimals: 18, chainflipAssetId: "Ethereum:ETH" },
  { thorAsset: "ETH.USDC-0XA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48", chain: "ethereum", symbol: "USDC", decimals: 6, chainflipAssetId: "Ethereum:USDC" },
  { thorAsset: "ETH.USDT-0XDAC17F958D2EE523A2206206994597C13D831EC7", chain: "ethereum", symbol: "USDT", decimals: 6, chainflipAssetId: "Ethereum:USDT" },
  { thorAsset: "TRON.USDT-TR7NHQJEKQXGTCI8Q8ZY4PL8OTSZGJLJ6T", chain: "tron", symbol: "USDT", decimals: 6, chainflipAssetId: "Tron:USDT" },
  { thorAsset: "LTC.LTC", chain: "ltc", symbol: "LTC", decimals: 8 },
  { thorAsset: "BSC.BNB", chain: "bsc", symbol: "BNB", decimals: 18 },
  { thorAsset: "BCH.BCH", chain: "bch", symbol: "BCH", decimals: 8 },
  { thorAsset: "XRP.XRP", chain: "xrp", symbol: "XRP", decimals: 6 },
  { thorAsset: "DOGE.DOGE", chain: "doge", symbol: "DOGE", decimals: 8 },
  { thorAsset: "SOL.SOL", chain: "sol", symbol: "SOL", decimals: 9, chainflipAssetId: "Solana:SOL" },
  { thorAsset: "TRON.TRX", chain: "tron", symbol: "TRX", decimals: 6, chainflipAssetId: "Tron:TRX" },
];

function staticCatalogAssets(): CatalogAsset[] {
  return staticAssetDefinitions.map((asset) => {
    const parsed = parsePoolAsset(asset.thorAsset);
    return {
      id: parsed.id,
      label: `${asset.symbol} · ${asset.chain}`,
      chain: asset.chain,
      symbol: asset.symbol,
      thorAsset: asset.thorAsset,
      priceUsd: null,
      decimals: asset.decimals,
      support: {
        thorchain: { source: true, destination: true, assetId: asset.thorAsset },
        chainflip: { source: Boolean(asset.chainflipAssetId), destination: Boolean(asset.chainflipAssetId), assetId: asset.chainflipAssetId },
        "near-intents": { source: true, destination: true },
        maya: { source: false, destination: false },
      },
    };
  }).sort((a, b) => a.label.localeCompare(b.label));
}

export function resolveFixedThorRoutes(assets: CatalogAsset[], limit = fixedThorRouteCount) {
  const requestedPairs = fixedThorAssetPairs.slice(0, limit);
  const missingRouteIds: string[] = [];
  const assetsByThorId = new Map(assets.map((asset) => [asset.thorAsset, asset]));
  const routes = requestedPairs.flatMap(([sourceId, destinationId]) => {
    const source = assetsByThorId.get(sourceId);
    const destination = assetsByThorId.get(destinationId);
    if (!source || !destination) {
      missingRouteIds.push(`${sourceId}→${destinationId}`);
      return [];
    }
    const partners = (["thorchain", "chainflip", "near-intents", "maya"] as PartnerId[]).filter((partner) =>
      source.support[partner].source && destination.support[partner].destination
    );
    if (partners.length <= 1) {
      missingRouteIds.push(`${sourceId}→${destinationId}`);
      return [];
    }
    return [{ id: `${source.id}__${destination.id}`, source, destination, partners }];
  });
  return { routes, missingRouteIds };
}

export function topThorRoutes(assets: CatalogAsset[], limit = fixedThorRouteCount) {
  return resolveFixedThorRoutes(assets, limit).routes;
}
