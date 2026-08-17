export type ProtocolId = "thorchain" | "chainflip" | "near-intents" | "maya";
export type ExecutionMode = "standard" | "optimized";
export type ExecutionStrategy = "single" | "streaming" | "regular" | "dca" | "solver";

export type ChainAsset = {
  canonicalId: string;
  chain: string;
  symbol: string;
  decimals: number;
  protocolIds: Partial<Record<ProtocolId, string>>;
};

export type BenchmarkRequest = {
  pairId: string;
  source: ChainAsset;
  destination: ChainAsset;
  sourceAmountBaseUnits: string;
  sourceAmountUsd: number;
  sourcePriceUsd: number;
  mode: ExecutionMode;
  recipient: string;
  refundAddress: string;
  slippageToleranceBps: number;
};

export type NormalizedQuote = {
  protocol: ProtocolId;
  strategy: ExecutionStrategy;
  status: "quoted" | "unavailable" | "error";
  expectedOutputBaseUnits?: string;
  expectedOutputFormatted?: string;
  quotedFeeUsd?: number;
  estimatedDurationSeconds?: number;
  requestStartedAt: string;
  responseReceivedAt?: string;
  quoteExpiresAt?: string;
  errorCode?: string;
  errorMessage?: string;
  requestUrl?: string;
  requestPayload?: unknown;
  responseHttpStatus?: number;
  responseLatencyMs?: number;
  rawResponse: unknown;
};
