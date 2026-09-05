import type { BenchmarkRequest, NormalizedQuote } from "./types";

export const thorQuoteAnalysisModelVersion = "thor-analysis-v1";
export const competitivenessToleranceBps = 5;

export type ThorPoolDepth = {
  asset: string;
  assetDepth: string;
  runeDepth: string;
  liquidityUsd: number;
};

export type ThorPoolDepthSnapshot = {
  capturedAt: string;
  pools: ThorPoolDepth[];
};

export function poolDepthSnapshotFromAssets(
  assets: Array<{ thorPoolDepth?: ThorPoolDepth }>,
  capturedAt: string,
): ThorPoolDepthSnapshot {
  return {
    capturedAt,
    pools: assets.flatMap((asset) => asset.thorPoolDepth ? [asset.thorPoolDepth] : []),
  };
}

export type ThorQuoteAnalysis = {
  modelVersion: typeof thorQuoteAnalysisModelVersion;
  status: "available" | "unavailable";
  reason?: string;
  capturedAt: string;
  competitiveWithinBps: number;
  bestProtocol?: NormalizedQuote["protocol"];
  bestOutput?: number;
  currentThorOutput?: number;
  currentGapBps?: number;
  sourceAmountFormatted?: number;
  poolImpliedRate?: number;
  oracleRate?: number | null;
  bestQuoteRate?: number;
  poolRateGapVsOracleBps?: number | null;
  currentOracleGapBps?: number | null;
  executionDragVsOracleBps?: number | null;
  executionCostVsOracleBps?: number | null;
  reportedSlippageVsOracleBps?: number | null;
  liquidityFeeVsOracleBps?: number | null;
  outboundFeeVsOracleBps?: number | null;
  unexplainedExecutionCostVsOracleBps?: number | null;
};

type ThorQuoteResponse = {
  fees?: {
    outbound?: string;
    liquidity?: string;
    slippage_bps?: number;
  };
};

function positiveNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function nonNegativeNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function quoteOutput(quote: NormalizedQuote | undefined) {
  return quote?.status === "quoted" ? positiveNumber(quote.expectedOutputFormatted) : null;
}

function thorResponse(value: unknown): ThorQuoteResponse | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as ThorQuoteResponse : null;
}

export function analyzeThorQuote(
  request: BenchmarkRequest,
  quotes: NormalizedQuote[],
  snapshot: ThorPoolDepthSnapshot,
): ThorQuoteAnalysis {
  const unavailable = (reason: string): ThorQuoteAnalysis => ({
    modelVersion: thorQuoteAnalysisModelVersion,
    status: "unavailable",
    reason,
    capturedAt: snapshot.capturedAt,
    competitiveWithinBps: competitivenessToleranceBps,
  });
  const thorQuote = quotes.find((quote) => quote.protocol === "thorchain");
  const currentThorOutput = quoteOutput(thorQuote);
  if (currentThorOutput == null) return unavailable("THORChain did not return a usable quote");
  const competitors = quotes.flatMap((quote) => {
    if (quote.protocol === "thorchain") return [];
    const output = quoteOutput(quote);
    return output == null ? [] : [{ protocol: quote.protocol, output }];
  }).sort((left, right) => right.output - left.output);
  const best = competitors[0];
  if (!best) return unavailable("No competing DEX returned a usable quote");
  const sourcePool = snapshot.pools.find((pool) => pool.asset === request.source.protocolIds.thorchain);
  const destinationPool = snapshot.pools.find((pool) => pool.asset === request.destination.protocolIds.thorchain);
  if (!sourcePool || !destinationPool) return unavailable("The synchronized THORChain pool snapshot is incomplete");

  const sourceAmountFormatted = Number(request.sourceAmountBaseUnits) / (10 ** request.source.decimals);
  if (!Number.isFinite(sourceAmountFormatted) || sourceAmountFormatted <= 0) return unavailable("The source amount cannot be normalized");
  const sourceAssetDepth = positiveNumber(sourcePool.assetDepth);
  const sourceRuneDepth = positiveNumber(sourcePool.runeDepth);
  const destinationAssetDepth = positiveNumber(destinationPool.assetDepth);
  const destinationRuneDepth = positiveNumber(destinationPool.runeDepth);
  const poolImpliedRate = sourceAssetDepth && sourceRuneDepth && destinationAssetDepth && destinationRuneDepth
    ? sourceRuneDepth / sourceAssetDepth * destinationAssetDepth / destinationRuneDepth
    : null;
  if (poolImpliedRate == null) return unavailable("The THORChain pool exchange rate cannot be calculated");

  const poolImpliedOutput = sourceAmountFormatted * poolImpliedRate;
  const bestQuoteRate = best.output / sourceAmountFormatted;
  const oracleGap = thorQuote?.oracleGapBps;
  const oracleReferenceOutput = typeof oracleGap === "number" && Number.isFinite(oracleGap) && 1 + oracleGap / 10_000 > 0
    ? currentThorOutput / (1 + oracleGap / 10_000)
    : null;
  const oracleRate = oracleReferenceOutput == null ? null : oracleReferenceOutput / sourceAmountFormatted;
  const poolRateGapVsOracleBps = oracleReferenceOutput == null ? null : (poolImpliedOutput / oracleReferenceOutput - 1) * 10_000;
  const currentOracleGapBps = oracleReferenceOutput == null ? null : (currentThorOutput / oracleReferenceOutput - 1) * 10_000;
  const executionDragVsOracleBps = currentOracleGapBps == null || poolRateGapVsOracleBps == null
    ? null
    : currentOracleGapBps - poolRateGapVsOracleBps;
  const executionCostVsOracleBps = executionDragVsOracleBps == null ? null : Math.max(0, -executionDragVsOracleBps);
  const currentGapBps = (currentThorOutput / best.output - 1) * 10_000;

  const rawResponse = thorResponse(thorQuote?.rawResponse);
  const outboundFee = nonNegativeNumber(rawResponse?.fees?.outbound);
  const liquidityFee = nonNegativeNumber(rawResponse?.fees?.liquidity);
  const reportedSlippageBps = nonNegativeNumber(rawResponse?.fees?.slippage_bps);
  const reportedSlippageVsOracleBps = reportedSlippageBps == null || oracleReferenceOutput == null
    ? null
    : reportedSlippageBps * poolImpliedOutput / oracleReferenceOutput;
  const liquidityFeeVsOracleBps = liquidityFee == null || oracleReferenceOutput == null
    ? null
    : liquidityFee / 1e8 / oracleReferenceOutput * 10_000;
  const outboundFeeVsOracleBps = outboundFee == null || oracleReferenceOutput == null
    ? null
    : outboundFee / 1e8 / oracleReferenceOutput * 10_000;
  const unexplainedExecutionCostVsOracleBps = executionCostVsOracleBps == null
    || reportedSlippageVsOracleBps == null
    || liquidityFeeVsOracleBps == null
    || outboundFeeVsOracleBps == null
    ? null
    : executionCostVsOracleBps - reportedSlippageVsOracleBps - liquidityFeeVsOracleBps - outboundFeeVsOracleBps;

  return {
    modelVersion: thorQuoteAnalysisModelVersion,
    status: "available",
    capturedAt: snapshot.capturedAt,
    competitiveWithinBps: competitivenessToleranceBps,
    bestProtocol: best.protocol,
    bestOutput: best.output,
    currentThorOutput,
    currentGapBps,
    sourceAmountFormatted,
    poolImpliedRate,
    oracleRate,
    bestQuoteRate,
    poolRateGapVsOracleBps,
    currentOracleGapBps,
    executionDragVsOracleBps,
    executionCostVsOracleBps,
    reportedSlippageVsOracleBps,
    liquidityFeeVsOracleBps,
    outboundFeeVsOracleBps,
    unexplainedExecutionCostVsOracleBps,
  };
}
