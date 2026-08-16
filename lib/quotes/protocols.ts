import type { BenchmarkRequest, ExecutionStrategy, ProtocolId } from "./types";

export const protocolCapabilities: Record<ProtocolId, {
  standard: ExecutionStrategy;
  optimized: ExecutionStrategy;
  requestsPerSecond?: number;
  requiresApiKey: boolean;
}> = {
  thorchain: { standard: "single", optimized: "streaming", requiresApiKey: false },
  chainflip: { standard: "regular", optimized: "dca", requiresApiKey: false },
  "near-intents": { standard: "solver", optimized: "solver", requiresApiKey: true },
  maya: { standard: "single", optimized: "streaming", requestsPerSecond: 1, requiresApiKey: false },
};

export function strategyFor(protocol: ProtocolId, request: Pick<BenchmarkRequest, "mode">) {
  return protocolCapabilities[protocol][request.mode];
}

export function isLiveBenchmarkConfigured(env: Record<string, string | undefined>) {
  return Boolean(
    env.NEAR_INTENTS_API_KEY &&
    env.BENCHMARK_BTC_ADDRESS &&
    env.BENCHMARK_EVM_ADDRESS &&
    env.BENCHMARK_NEAR_ACCOUNT
  );
}
