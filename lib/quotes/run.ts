import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { ensureBenchmarkSchema, getDb } from "../../db";
import { benchmarkRuns, protocolQuotes } from "../../db/schema";
import { getCatalog, topThorRoutes, type CatalogAsset, type PartnerId } from "../routes/catalog";
import { getChainflipQuote } from "./adapters/chainflip";
import { getNearIntentsQuote } from "./adapters/near-intents";
import { getPoolProtocolQuote } from "./adapters/pool-protocol";
import { quoteSizes } from "./sizes";
import type { BenchmarkRequest, ChainAsset, NormalizedQuote, ProtocolId } from "./types";

const allProtocols: ProtocolId[] = ["thorchain", "chainflip", "near-intents", "maya"];

const addressByChain: Record<string, string> = {
  bitcoin: "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh",
  ethereum: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
  arbitrum: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
  avalanche: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
  base: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
  bsc: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
  tron: "TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7",
  solana: "11111111111111111111111111111111",
  near: "intents.near",
};

function toChainAsset(asset: CatalogAsset): ChainAsset {
  const protocolIds: Partial<Record<ProtocolId, string>> = {};
  for (const protocol of allProtocols) {
    const assetId = asset.support[protocol].assetId;
    if (assetId) protocolIds[protocol] = assetId;
  }
  return { canonicalId: asset.id, chain: asset.chain, symbol: asset.symbol, decimals: asset.decimals, protocolIds };
}

function usdToBaseUnits(amountUsd: number, priceUsd: number, decimals: number) {
  const precision = 100_000_000;
  const usd = BigInt(Math.round(amountUsd * precision));
  const price = BigInt(Math.round(priceUsd * precision));
  if (price <= 0n) throw new Error("Source asset price is unavailable");
  return (usd * (10n ** BigInt(decimals)) / price).toString();
}

function unavailable(protocol: PartnerId, requestStartedAt: string): NormalizedQuote {
  const strategies = { thorchain: "single", chainflip: "regular", "near-intents": "solver", maya: "single" } as const;
  return { protocol, strategy: strategies[protocol], status: "unavailable", requestStartedAt, errorCode: "UNSUPPORTED_PAIR", errorMessage: "This protocol does not support the selected route.", rawResponse: null };
}

async function requestQuote(protocol: PartnerId, request: BenchmarkRequest, supported: boolean, apiKey?: string) {
  if (!supported) return unavailable(protocol, new Date().toISOString());
  if (protocol === "thorchain" || protocol === "maya") return getPoolProtocolQuote(protocol, request);
  if (protocol === "chainflip") return getChainflipQuote(request);
  if (!apiKey) {
    return { ...unavailable(protocol, new Date().toISOString()), status: "error" as const, errorCode: "MISSING_API_KEY", errorMessage: "NEAR Intents API key is not configured." };
  }
  return getNearIntentsQuote(request, apiKey);
}

export async function runSelectedBenchmark(routeId: string, amountId: string) {
  await ensureBenchmarkSchema();
  const catalog = await getCatalog();
  const route = topThorRoutes(catalog.assets).find((candidate) => candidate.id === routeId);
  if (!route) throw new Error("Select one of the fixed 30 THORChain routes");
  const quoteSize = quoteSizes.find((candidate) => candidate.id === amountId);
  if (!quoteSize) throw new Error("Unknown quote amount");
  if (!route.source.priceUsd || route.source.priceUsd <= 0) throw new Error("Source asset USD price is unavailable");

  const sourceAmountUsd = quoteSize.amountUsd;
  const source = toChainAsset(route.source);
  const destination = toChainAsset(route.destination);
  const request: BenchmarkRequest = {
    pairId: route.id,
    source,
    destination,
    sourceAmountBaseUnits: usdToBaseUnits(sourceAmountUsd, route.source.priceUsd, source.decimals),
    sourceAmountUsd,
    sourcePriceUsd: route.source.priceUsd,
    mode: "standard",
    recipient: addressByChain[destination.chain] ?? "intents.near",
    refundAddress: addressByChain[source.chain] ?? "intents.near",
    slippageToleranceBps: 100,
  };

  const initiatedAt = new Date().toISOString();
  const db = getDb();
  const [run] = await db.insert(benchmarkRuns).values({
    pairId: route.id,
    rangeId: amountId,
    samplePoint: "scheduled_midpoint",
    sourceAsset: route.source.thorAsset,
    destinationAsset: route.destination.thorAsset,
    sourceAmountBaseUnits: request.sourceAmountBaseUnits,
    sourceAmountUsd,
    sourcePriceUsd: route.source.priceUsd,
    mode: "standard",
    status: "pending",
    initiatedAt,
  }).returning({ id: benchmarkRuns.id });

  const apiKey = (env as unknown as { NEAR_INTENTS_API_KEY?: string }).NEAR_INTENTS_API_KEY;
  const quotes = await Promise.all(allProtocols.map((protocol) => requestQuote(protocol, request, route.partners.includes(protocol), apiKey)));
  const startTimes = quotes.map((quote) => new Date(quote.requestStartedAt).getTime()).filter(Number.isFinite);
  const maxRequestSkewMs = startTimes.length ? Math.max(...startTimes) - Math.min(...startTimes) : 0;
  const completedAt = new Date().toISOString();
  const hasError = quotes.some((quote) => quote.status === "error");

  await db.insert(protocolQuotes).values(quotes.map((quote) => ({
    runId: run.id,
    protocol: quote.protocol,
    strategy: quote.strategy,
    status: quote.status,
    expectedOutputBaseUnits: quote.expectedOutputBaseUnits,
    expectedOutputFormatted: quote.expectedOutputFormatted,
    quotedFeeUsd: quote.quotedFeeUsd,
    estimatedDurationSeconds: quote.estimatedDurationSeconds,
    requestStartedAt: quote.requestStartedAt,
    responseReceivedAt: quote.responseReceivedAt,
    quoteExpiresAt: quote.quoteExpiresAt,
    rawResponseJson: quote.rawResponse == null ? undefined : JSON.stringify(quote.rawResponse),
    requestUrl: quote.requestUrl,
    requestPayloadJson: quote.requestPayload ? JSON.stringify(quote.requestPayload) : undefined,
    responseHttpStatus: quote.responseHttpStatus,
    responseLatencyMs: quote.responseLatencyMs,
    errorCode: quote.errorCode,
    errorMessage: quote.errorMessage,
  })));

  await db.update(benchmarkRuns).set({
    status: hasError ? "partial" : "complete",
    completedAt,
    maxRequestSkewMs,
  }).where(eq(benchmarkRuns.id, run.id));

  return { runId: run.id, routeId, amountId, quoteCount: quotes.length, completedAt };
}
