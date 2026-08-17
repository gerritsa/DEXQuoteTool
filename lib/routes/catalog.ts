export type PartnerId = "thorchain" | "chainflip" | "near-intents" | "maya";

type ThorPool = { asset: string; status: string; assetPriceUSD?: string; nativeDecimal?: string };
type MayaPool = { asset: string; status: string };
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
  support: Record<PartnerId, { source: boolean; destination: boolean; assetId?: string }>;
};

export type CatalogRoute = {
  id: string;
  source: CatalogAsset;
  destination: CatalogAsset;
  partners: PartnerId[];
};

const THOR_MIDGARD_POOLS = "https://gateway.liquify.com/chain/thorchain_midgard/v2/pools";
const MAYA_POOLS = "https://mayanode.mayachain.info/mayachain/pools";
const NEAR_TOKENS = "https://1click.chaindefuser.com/v0/tokens";
const CHAINFLIP_NETWORK_INFO = "https://chainflip-swap.chainflip.io/api/networkInfo";

// Chain and contract identity comes from Chainflip SDK 2.2.1. The network-info
// response below determines whether each asset is currently enabled.
const CHAINFLIP_ASSETS: ChainflipAssetDefinition[] = [
  { chainflipId: "Usdc", chain: "Ethereum", symbol: "USDC", contractAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
  { chainflipId: "Eth", chain: "Ethereum", symbol: "ETH" },
  { chainflipId: "Btc", chain: "Bitcoin", symbol: "BTC" },
  { chainflipId: "TrxUsdt", chain: "Tron", symbol: "USDT", contractAddress: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t" },
  { chainflipId: "Usdt", chain: "Ethereum", symbol: "USDT", contractAddress: "0xdAC17F958D2ee523a2206206994597C13D831ec7" },
  { chainflipId: "Trx", chain: "Tron", symbol: "TRX" },
];

const chainAliases: Record<string, string> = {
  BTC: "bitcoin", Bitcoin: "bitcoin", btc: "bitcoin",
  ETH: "ethereum", Ethereum: "ethereum", eth: "ethereum",
  AVAX: "avalanche", avax: "avalanche",
  TRON: "tron", Tron: "tron", tron: "tron",
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

let cache: { expiresAt: number; value: Awaited<ReturnType<typeof buildCatalog>> } | undefined;

async function buildCatalog() {
  const [thorResult, mayaResult, nearResult, chainflipResult] = await Promise.allSettled([
    fetchJson<ThorPool[]>(THOR_MIDGARD_POOLS),
    fetchJson<MayaPool[]>(MAYA_POOLS),
    fetchJson<NearToken[]>(NEAR_TOKENS),
    fetchJson<ChainflipNetworkInfo>(CHAINFLIP_NETWORK_INFO, { "X-Chainflip-Sdk-Version": "2.2.1" }),
  ]);

  if (thorResult.status === "rejected") throw new Error(`THORChain catalog unavailable: ${thorResult.reason}`);

  const maya = mayaResult.status === "fulfilled" ? mayaResult.value : [];
  const near = nearResult.status === "fulfilled" ? nearResult.value : [];
  const chainflipNetworkAssets = chainflipResult.status === "fulfilled" ? chainflipResult.value.assets : [];

  const mayaAssets = new Map(maya.filter((pool) => pool.status.toLowerCase() === "available").map((pool) => {
    const parsed = parsePoolAsset(pool.asset);
    return [parsed.id, pool.asset];
  }));
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

  const thorPools = thorResult.value.filter((pool) => pool.status.toLowerCase() === "available" && fixedThorAssets.has(pool.asset));

  const assets: CatalogAsset[] = thorPools.map((pool) => {
    const parsed = parsePoolAsset(pool.asset);
    const cfSource = cfSourceAssets.get(parsed.id);
    const cfDestination = cfDestinationAssets.get(parsed.id);
    const nearAsset = nearAssets.get(parsed.id);
    const mayaAsset = mayaAssets.get(parsed.id);
    return {
      id: parsed.id,
      label: `${parsed.symbol} · ${parsed.chain}`,
      chain: parsed.chain,
      symbol: parsed.symbol,
      thorAsset: pool.asset,
      priceUsd: pool.assetPriceUSD ? Number(pool.assetPriceUSD) : null,
      decimals: Number(pool.nativeDecimal ?? 8),
      support: {
        thorchain: { source: true, destination: true, assetId: pool.asset },
        chainflip: { source: Boolean(cfSource), destination: Boolean(cfDestination), assetId: cfSource ?? cfDestination },
        "near-intents": { source: Boolean(nearAsset), destination: Boolean(nearAsset), assetId: nearAsset },
        maya: { source: Boolean(mayaAsset), destination: Boolean(mayaAsset), assetId: mayaAsset },
      },
    };
  }).sort((a, b) => a.label.localeCompare(b.label));

  return { assets };
}

export async function getCatalog() {
  if (cache && cache.expiresAt > Date.now()) return cache.value;
  const value = await buildCatalog();
  cache = { value, expiresAt: Date.now() + 5 * 60_000 };
  return value;
}

const fixedThorAssetPairs: Array<[string, string]> = [
  ["BTC.BTC", "ETH.ETH"],
  ["ETH.ETH", "BTC.BTC"],
  ["BTC.BTC", "TRON.TRX"],
  ["TRON.TRX", "BTC.BTC"],
  ["ETH.ETH", "TRON.TRX"],
  ["TRON.TRX", "ETH.ETH"],
  ["BTC.BTC", "ETH.USDC-0XA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48"],
  ["ETH.USDC-0XA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48", "BTC.BTC"],
  ["ETH.ETH", "ETH.USDC-0XA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48"],
  ["ETH.USDC-0XA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48", "ETH.ETH"],
  ["BTC.BTC", "ETH.USDT-0XDAC17F958D2EE523A2206206994597C13D831EC7"],
  ["ETH.USDT-0XDAC17F958D2EE523A2206206994597C13D831EC7", "BTC.BTC"],
  ["ETH.ETH", "ETH.USDT-0XDAC17F958D2EE523A2206206994597C13D831EC7"],
  ["ETH.USDT-0XDAC17F958D2EE523A2206206994597C13D831EC7", "ETH.ETH"],
  ["BTC.BTC", "TRON.USDT-TR7NHQJEKQXGTCI8Q8ZY4PL8OTSZGJLJ6T"],
  ["TRON.USDT-TR7NHQJEKQXGTCI8Q8ZY4PL8OTSZGJLJ6T", "BTC.BTC"],
  ["ETH.ETH", "TRON.USDT-TR7NHQJEKQXGTCI8Q8ZY4PL8OTSZGJLJ6T"],
  ["TRON.USDT-TR7NHQJEKQXGTCI8Q8ZY4PL8OTSZGJLJ6T", "ETH.ETH"],
  ["AVAX.AVAX", "BTC.BTC"],
  ["BTC.BTC", "AVAX.AVAX"],
];
const fixedThorAssets = new Set(fixedThorAssetPairs.flat());

export function topThorRoutes(assets: CatalogAsset[], limit = 20) {
  const assetsByThorId = new Map(assets.map((asset) => [asset.thorAsset, asset]));
  return fixedThorAssetPairs
    .map(([sourceId, destinationId]) => {
      const source = assetsByThorId.get(sourceId);
      const destination = assetsByThorId.get(destinationId);
      if (!source || !destination) return null;
      const partners = (["thorchain", "chainflip", "near-intents", "maya"] as PartnerId[]).filter((partner) =>
        source.support[partner].source && destination.support[partner].destination
      );
      return { id: `${source.id}__${destination.id}`, source, destination, partners };
    })
    .filter((route): route is CatalogRoute => Boolean(route))
    .filter((route) => route.partners.length > 1)
    .slice(0, limit);
}
