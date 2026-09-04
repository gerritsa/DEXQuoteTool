import type { BenchmarkRequest, NormalizedQuote } from "./types";

export const depthForecastModelVersion = "thor-depth-v2";
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

export type DepthForecastPool = ThorPoolDepth & {
  role: "source" | "destination";
  requiredMultiplierIfScaledAlone: number | null;
  requiredAdditionalLiquidityUsd: number | null;
};

export type ThorDepthForecast = {
  modelVersion: typeof depthForecastModelVersion;
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
  poolRateGapVsBestBps?: number;
  executionDragBps?: number;
  asymptoticGapBps?: number | null;
  depthRecoverableBps?: number | null;
  outboundFeeBps?: number;
  streamingChunks?: number;
  requiredDepthMultiplier?: number | null;
  requiredAdditionalLiquidityUsd?: number | null;
  depthAloneSufficient?: boolean;
  priceRebalanceBps?: number | null;
  bindingPool?: "source" | "destination" | "balanced" | null;
  sourcePool?: DepthForecastPool;
  destinationPool?: DepthForecastPool;
  curve?: Array<{ multiplier: number; gapBps: number }>;
};

type ThorQuoteResponse = {
  max_streaming_quantity?: number;
  fees?: { outbound?: string };
};

function positiveNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function quoteOutput(quote: NormalizedQuote | undefined) {
  return quote?.status === "quoted" ? positiveNumber(quote.expectedOutputFormatted) : null;
}

function thorResponse(value: unknown): ThorQuoteResponse | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as ThorQuoteResponse : null;
}

function swapOutput(input: number, inputDepth: number, outputDepth: number) {
  const denominator = input + inputDepth;
  return input * inputDepth * outputDepth / (denominator * denominator);
}

export function simulateThorOutput(
  inputAmount: number,
  sourcePool: ThorPoolDepth,
  destinationPool: ThorPoolDepth,
  sourceMultiplier: number,
  destinationMultiplier: number,
  chunks: number,
) {
  const sourceAssetDepth = Number(sourcePool.assetDepth) * sourceMultiplier;
  const sourceRuneDepth = Number(sourcePool.runeDepth) * sourceMultiplier;
  const destinationRuneDepth = Number(destinationPool.runeDepth) * destinationMultiplier;
  const destinationAssetDepth = Number(destinationPool.assetDepth) * destinationMultiplier;
  if (![inputAmount, sourceAssetDepth, sourceRuneDepth, destinationRuneDepth, destinationAssetDepth].every((value) => Number.isFinite(value) && value > 0)) return null;
  const chunkCount = Math.max(1, Math.floor(chunks));
  const chunkInput = inputAmount / chunkCount;
  const runeOutput = swapOutput(chunkInput, sourceAssetDepth, sourceRuneDepth);
  const assetOutput = swapOutput(runeOutput, destinationRuneDepth, destinationAssetDepth);
  const output = assetOutput * chunkCount;
  return Number.isFinite(output) && output > 0 ? output : null;
}

function findRequiredMultiplier(target: number, outputAt: (multiplier: number) => number | null) {
  const current = outputAt(1);
  if (current != null && current >= target) return 1;
  const maximum = 1_000;
  const maximumOutput = outputAt(maximum);
  if (maximumOutput == null || maximumOutput < target) return null;
  let low = 1;
  let high = maximum;
  for (let index = 0; index < 48; index += 1) {
    const middle = (low + high) / 2;
    const output = outputAt(middle);
    if (output != null && output >= target) high = middle;
    else low = middle;
  }
  return high;
}

function poolForecast(
  pool: ThorPoolDepth,
  role: DepthForecastPool["role"],
  requiredMultiplierIfScaledAlone: number | null,
): DepthForecastPool {
  return {
    ...pool,
    role,
    requiredMultiplierIfScaledAlone,
    requiredAdditionalLiquidityUsd: requiredMultiplierIfScaledAlone == null
      ? null
      : Math.max(0, pool.liquidityUsd * (requiredMultiplierIfScaledAlone - 1)),
  };
}

export function forecastThorDepth(
  request: BenchmarkRequest,
  quotes: NormalizedQuote[],
  snapshot: ThorPoolDepthSnapshot,
): ThorDepthForecast {
  const unavailable = (reason: string): ThorDepthForecast => ({
    modelVersion: depthForecastModelVersion,
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
  const sourceAsset = request.source.protocolIds.thorchain;
  const destinationAsset = request.destination.protocolIds.thorchain;
  const sourcePool = snapshot.pools.find((pool) => pool.asset === sourceAsset);
  const destinationPool = snapshot.pools.find((pool) => pool.asset === destinationAsset);
  if (!sourcePool || !destinationPool) return unavailable("The synchronized THORChain pool snapshot is incomplete");

  const inputAmount = Number(request.sourceAmountBaseUnits) / (10 ** request.source.decimals) * 1e8;
  if (!Number.isFinite(inputAmount) || inputAmount <= 0) return unavailable("The source amount cannot be normalized to THORChain units");
  const sourceAmountFormatted = inputAmount / 1e8;
  const rawResponse = thorResponse(thorQuote?.rawResponse);
  const requestedChunks = positiveNumber(rawResponse?.max_streaming_quantity);
  const chunks = request.mode === "optimized"
    ? Math.max(1, Math.floor(requestedChunks ?? 1))
    : 1;
  const outboundFee = positiveNumber(rawResponse?.fees?.outbound) ?? 0;
  const modeledCurrent = simulateThorOutput(inputAmount, sourcePool, destinationPool, 1, 1, chunks);
  if (modeledCurrent == null) return unavailable("The THORChain pool depths cannot be simulated");

  const currentThorInternal = currentThorOutput * 1e8;
  const calibration = currentThorInternal - (modeledCurrent - outboundFee);
  const outputAt = (sourceMultiplier: number, destinationMultiplier: number) => {
    const modeled = simulateThorOutput(inputAmount, sourcePool, destinationPool, sourceMultiplier, destinationMultiplier, chunks);
    if (modeled == null) return null;
    return Math.max(0, modeled - outboundFee + calibration) / 1e8;
  };
  const target = best.output * (1 - competitivenessToleranceBps / 10_000);
  const requiredDepthMultiplier = findRequiredMultiplier(target, (multiplier) => outputAt(multiplier, multiplier));
  const sourceOnlyMultiplier = findRequiredMultiplier(target, (multiplier) => outputAt(multiplier, 1));
  const destinationOnlyMultiplier = findRequiredMultiplier(target, (multiplier) => outputAt(1, multiplier));
  const sourceSensitivity = (outputAt(1.01, 1) ?? currentThorOutput) - currentThorOutput;
  const destinationSensitivity = (outputAt(1, 1.01) ?? currentThorOutput) - currentThorOutput;
  const sensitivityDifference = Math.abs(sourceSensitivity - destinationSensitivity);
  const bindingPool = sensitivityDifference <= Math.max(sourceSensitivity, destinationSensitivity) * 0.05
    ? "balanced" as const
    : sourceSensitivity > destinationSensitivity ? "source" as const : "destination" as const;
  const asymptoticOutput = outputAt(1_000_000, 1_000_000);
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
  const poolRateGapVsBestBps = (poolImpliedOutput / best.output - 1) * 10_000;
  const poolRateGapVsOracleBps = oracleReferenceOutput == null ? null : (poolImpliedOutput / oracleReferenceOutput - 1) * 10_000;
  const currentGapBps = (currentThorOutput / best.output - 1) * 10_000;
  const asymptoticGapBps = asymptoticOutput == null ? null : (asymptoticOutput / best.output - 1) * 10_000;
  const depthRecoverableBps = asymptoticGapBps == null ? null : asymptoticGapBps - currentGapBps;
  const executionDragBps = currentGapBps - poolRateGapVsBestBps;
  const outboundFeeBps = outboundFee / 1e8 / best.output * 10_000;
  const depthAloneSufficient = requiredDepthMultiplier != null;
  const priceRebalanceBps = !depthAloneSufficient && asymptoticOutput
    ? Math.max(0, (target / asymptoticOutput - 1) * 10_000)
    : null;
  const requiredAdditionalLiquidityUsd = requiredDepthMultiplier == null
    ? null
    : Math.max(0, (sourcePool.liquidityUsd + destinationPool.liquidityUsd) * (requiredDepthMultiplier - 1));

  const multipliers = new Set([0.5, 0.75, 1, 1.25, 1.5, 2, 3, 5, 10]);
  if (requiredDepthMultiplier != null) multipliers.add(requiredDepthMultiplier);
  const curve = [...multipliers].sort((left, right) => left - right).flatMap((multiplier) => {
    const output = outputAt(multiplier, multiplier);
    return output == null ? [] : [{ multiplier, gapBps: (output / best.output - 1) * 10_000 }];
  });

  return {
    modelVersion: depthForecastModelVersion,
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
    poolRateGapVsBestBps,
    executionDragBps,
    asymptoticGapBps,
    depthRecoverableBps,
    outboundFeeBps,
    streamingChunks: chunks,
    requiredDepthMultiplier,
    requiredAdditionalLiquidityUsd,
    depthAloneSufficient,
    priceRebalanceBps,
    bindingPool,
    sourcePool: poolForecast(sourcePool, "source", sourceOnlyMultiplier),
    destinationPool: poolForecast(destinationPool, "destination", destinationOnlyMultiplier),
    curve,
  };
}
