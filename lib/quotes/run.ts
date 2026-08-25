import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { ensureBenchmarkSchema, getD1, getDb } from "../../db";
import { benchmarkRuns, protocolQuotes } from "../../db/schema";
import { getCatalog, topThorRoutes, type CatalogAsset, type PartnerId } from "../routes/catalog";
import { getChainflipQuote } from "./adapters/chainflip";
import { getNearIntentsQuote } from "./adapters/near-intents";
import { getPoolProtocolQuote } from "./adapters/pool-protocol";
import { strategyFor } from "./protocols";
import { quoteSizes } from "./sizes";
import type { BenchmarkRequest, ChainAsset, ExecutionMode, NormalizedQuote, ProtocolId } from "./types";

const allProtocols: ProtocolId[] = ["thorchain", "chainflip", "near-intents"];

type BenchmarkRuntimeEnv = {
  NEAR_INTENTS_API_KEY?: string;
  BENCHMARK_BTC_ADDRESS?: string;
  BENCHMARK_EVM_ADDRESS?: string;
  BENCHMARK_TRON_ADDRESS?: string;
};

export type BenchmarkRunOptions = { sweepId?: string; bundleIndex?: number };

export type BenchmarkArchiveRecord = {
  runId: number;
  routeId: string;
  amountId: string;
  mode: ExecutionMode;
  initiatedAt: string;
  completedAt: string;
  maxRequestSkewMs: number;
  request: BenchmarkRequest;
  quotes: NormalizedQuote[];
};

export type StoredBenchmarkResult = {
  runId: number;
  routeId: string;
  amountId: string;
  mode: ExecutionMode;
  quoteCount: number;
  completedAt: string;
  skipped: boolean;
  archive: BenchmarkArchiveRecord;
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

function addressForChain(chain: string, values: BenchmarkRuntimeEnv) {
  if (chain === "bitcoin") return values.BENCHMARK_BTC_ADDRESS;
  if (["ethereum", "arbitrum", "avalanche", "base", "bsc"].includes(chain)) return values.BENCHMARK_EVM_ADDRESS;
  if (chain === "tron") return values.BENCHMARK_TRON_ADDRESS;
  return undefined;
}

function unavailable(protocol: PartnerId, requestStartedAt: string, mode: ExecutionMode): NormalizedQuote {
  return { protocol, strategy: strategyFor(protocol, { mode }), status: "unavailable", requestStartedAt, errorCode: "UNSUPPORTED_PAIR", errorMessage: "This protocol does not support the selected route.", rawResponse: null };
}

async function requestQuote(protocol: PartnerId, request: BenchmarkRequest, supported: boolean, apiKey?: string) {
  if (!supported) return unavailable(protocol, new Date().toISOString(), request.mode);
  const signal = AbortSignal.timeout(15_000);
  if (protocol === "thorchain" || protocol === "maya") return getPoolProtocolQuote(protocol, request, signal);
  if (protocol === "chainflip") return getChainflipQuote(request, signal);
  if (!apiKey) return { ...unavailable(protocol, new Date().toISOString(), request.mode), status: "error" as const, errorCode: "MISSING_API_KEY", errorMessage: "NEAR Intents API key is not configured." };
  return getNearIntentsQuote(request, apiKey, signal);
}

async function latestPayloads(runId: number, routeId: string, amountId: string, mode: ExecutionMode) {
  return getD1().prepare(`
    SELECT protocol, request_url AS requestUrl, request_payload_json AS requestPayloadJson,
      raw_response_json AS rawResponseJson, error_message AS errorMessage
    FROM latest_quote_payloads
    WHERE run_id = ? AND pair_id = ? AND amount_id = ? AND mode = ?
  `).bind(runId, routeId, amountId, mode).all<{
    protocol: ProtocolId;
    requestUrl: string | null;
    requestPayloadJson: string | null;
    rawResponseJson: string | null;
    errorMessage: string | null;
  }>();
}

async function loadStoredArchive(runId: number, routeId: string, amountId: string, mode: ExecutionMode): Promise<BenchmarkArchiveRecord> {
  const db = getDb();
  const [run] = await db.select().from(benchmarkRuns).where(eq(benchmarkRuns.id, runId)).limit(1);
  if (!run?.completedAt) throw new Error("Stored benchmark is incomplete");
  const storedQuotes = await db.select().from(protocolQuotes).where(eq(protocolQuotes.runId, runId));
  const payloadResult = await latestPayloads(runId, routeId, amountId, mode);
  const payloadByProtocol = new Map(payloadResult.results.map((payload) => [payload.protocol, payload]));
  const quotes: NormalizedQuote[] = storedQuotes.map((quote) => {
    const payload = payloadByProtocol.get(quote.protocol);
    return {
      protocol: quote.protocol,
      strategy: quote.strategy,
      status: quote.status,
      expectedOutputBaseUnits: quote.expectedOutputBaseUnits ?? undefined,
      expectedOutputFormatted: quote.expectedOutputFormatted ?? undefined,
      quotedFeeUsd: quote.quotedFeeUsd ?? undefined,
      estimatedDurationSeconds: quote.estimatedDurationSeconds ?? undefined,
      requestStartedAt: quote.requestStartedAt,
      responseReceivedAt: quote.responseReceivedAt ?? undefined,
      quoteExpiresAt: quote.quoteExpiresAt ?? undefined,
      requestUrl: payload?.requestUrl ?? quote.requestUrl ?? undefined,
      requestPayload: payload?.requestPayloadJson ? JSON.parse(payload.requestPayloadJson) : undefined,
      responseHttpStatus: quote.responseHttpStatus ?? undefined,
      responseLatencyMs: quote.responseLatencyMs ?? undefined,
      errorCode: quote.errorCode ?? undefined,
      errorMessage: payload?.errorMessage ?? quote.errorMessage ?? undefined,
      rawResponse: payload?.rawResponseJson ? JSON.parse(payload.rawResponseJson) : null,
    };
  });
  return {
    runId,
    routeId,
    amountId,
    mode,
    initiatedAt: run.initiatedAt,
    completedAt: run.completedAt,
    maxRequestSkewMs: run.maxRequestSkewMs ?? 0,
    request: {
      pairId: routeId,
      source: { canonicalId: run.sourceAsset, chain: run.sourceAsset.split(".")[0].toLowerCase(), symbol: run.sourceAsset.split(".")[1] ?? run.sourceAsset, decimals: 8, protocolIds: {} },
      destination: { canonicalId: run.destinationAsset, chain: run.destinationAsset.split(".")[0].toLowerCase(), symbol: run.destinationAsset.split(".")[1] ?? run.destinationAsset, decimals: 8, protocolIds: {} },
      sourceAmountBaseUnits: run.sourceAmountBaseUnits,
      sourceAmountUsd: run.sourceAmountUsd,
      sourcePriceUsd: run.sourcePriceUsd,
      mode,
      recipient: "archived",
      refundAddress: "archived",
      slippageToleranceBps: 100,
    },
    quotes,
  };
}

async function upsertLatestPayloads(runId: number, routeId: string, amountId: string, mode: ExecutionMode, quotes: NormalizedQuote[], updatedAt: string) {
  const d1 = getD1();
  await d1.batch(quotes.map((quote) => d1.prepare(`
    INSERT INTO latest_quote_payloads (
      id, run_id, pair_id, amount_id, mode, protocol, request_url,
      request_payload_json, raw_response_json, error_message, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      run_id = excluded.run_id,
      request_url = excluded.request_url,
      request_payload_json = excluded.request_payload_json,
      raw_response_json = excluded.raw_response_json,
      error_message = excluded.error_message,
      updated_at = excluded.updated_at
  `).bind(
    `${routeId}|${amountId}|${mode}|${quote.protocol}`,
    runId,
    routeId,
    amountId,
    mode,
    quote.protocol,
    quote.requestUrl ?? null,
    quote.requestPayload == null ? null : JSON.stringify(quote.requestPayload),
    quote.rawResponse == null ? null : JSON.stringify(quote.rawResponse),
    quote.errorMessage ?? null,
    updatedAt,
  )));
}

export async function runSelectedBenchmark(routeId: string, amountId: string, mode: ExecutionMode = "standard", options: BenchmarkRunOptions = {}): Promise<StoredBenchmarkResult> {
  await ensureBenchmarkSchema();
  const catalog = await getCatalog();
  const route = topThorRoutes(catalog.assets).find((candidate) => candidate.id === routeId);
  if (!route) throw new Error("Select one of the fixed 20 THORChain routes");
  const quoteSize = quoteSizes.find((candidate) => candidate.id === amountId);
  if (!quoteSize) throw new Error("Unknown quote amount");
  if (!route.source.priceUsd || route.source.priceUsd <= 0) throw new Error("Source asset USD price is unavailable");

  const db = getDb();
  if (options.sweepId) {
    const [existing] = await db.select().from(benchmarkRuns).where(and(
      eq(benchmarkRuns.sweepId, options.sweepId),
      eq(benchmarkRuns.pairId, routeId),
      eq(benchmarkRuns.amountId, amountId),
      eq(benchmarkRuns.mode, mode),
    )).limit(1);
    if (existing?.completedAt && existing.status !== "pending") {
      const archive = await loadStoredArchive(existing.id, routeId, amountId, mode);
      return { runId: existing.id, routeId, amountId, mode, quoteCount: archive.quotes.length, completedAt: archive.completedAt, skipped: true, archive };
    }
  }

  const runtime = env as unknown as BenchmarkRuntimeEnv;
  const recipient = addressForChain(route.destination.chain, runtime);
  const refundAddress = addressForChain(route.source.chain, runtime);
  if (!recipient || !refundAddress) throw new Error(`Benchmark addresses are not configured for ${route.source.chain} → ${route.destination.chain}`);

  const sourceAmountUsd = quoteSize.amountUsd;
  const source = toChainAsset(route.source);
  const destination = toChainAsset(route.destination);
  const request: BenchmarkRequest = {
    pairId: route.id,
    source,
    destination,
    sourceAmountBaseUnits: usdToBaseUnits(sourceAmountUsd, route.source.priceUsd, route.source.decimals),
    sourceAmountUsd,
    sourcePriceUsd: route.source.priceUsd,
    mode,
    recipient,
    refundAddress,
    slippageToleranceBps: 100,
  };

  const initiatedAt = new Date().toISOString();
  const existingPending = options.sweepId ? await db.select().from(benchmarkRuns).where(and(
    eq(benchmarkRuns.sweepId, options.sweepId),
    eq(benchmarkRuns.pairId, routeId),
    eq(benchmarkRuns.amountId, amountId),
    eq(benchmarkRuns.mode, mode),
  )).limit(1) : [];
  let runId: number;
  if (existingPending[0]) {
    runId = existingPending[0].id;
    await db.delete(protocolQuotes).where(eq(protocolQuotes.runId, runId));
    await db.update(benchmarkRuns).set({ status: "pending", initiatedAt, completedAt: null }).where(eq(benchmarkRuns.id, runId));
  } else {
    const [run] = await db.insert(benchmarkRuns).values({
      pairId: route.id,
      amountId,
      sourceAsset: route.source.thorAsset,
      destinationAsset: route.destination.thorAsset,
      sourceAmountBaseUnits: request.sourceAmountBaseUnits,
      sourceAmountUsd,
      sourcePriceUsd: route.source.priceUsd,
      mode,
      status: "pending",
      initiatedAt,
      sweepId: options.sweepId,
      bundleIndex: options.bundleIndex,
    }).returning({ id: benchmarkRuns.id });
    runId = run.id;
  }

  const quotes = await Promise.all(allProtocols.map((protocol) => requestQuote(protocol, request, route.partners.includes(protocol), runtime.NEAR_INTENTS_API_KEY)));
  const startTimes = quotes.map((quote) => new Date(quote.requestStartedAt).getTime()).filter(Number.isFinite);
  const maxRequestSkewMs = startTimes.length ? Math.max(...startTimes) - Math.min(...startTimes) : 0;
  const completedAt = new Date().toISOString();
  const hasError = quotes.some((quote) => quote.status === "error");

  await db.insert(protocolQuotes).values(quotes.map((quote) => ({
    runId,
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
    requestUrl: quote.requestUrl,
    responseHttpStatus: quote.responseHttpStatus,
    responseLatencyMs: quote.responseLatencyMs,
    errorCode: quote.errorCode,
    errorMessage: quote.errorMessage,
  })));

  await db.update(benchmarkRuns).set({ status: hasError ? "partial" : "complete", completedAt, maxRequestSkewMs }).where(eq(benchmarkRuns.id, runId));
  await upsertLatestPayloads(runId, routeId, amountId, mode, quotes, completedAt);

  const archive: BenchmarkArchiveRecord = { runId, routeId, amountId, mode, initiatedAt, completedAt, maxRequestSkewMs, request, quotes };
  return { runId, routeId, amountId, mode, quoteCount: quotes.length, completedAt, skipped: false, archive };
}
