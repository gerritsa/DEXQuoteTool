import type { BenchmarkRequest, ExecutionStrategy, ProtocolId } from "./types";

const protocolStrategies: Record<ProtocolId, Record<BenchmarkRequest["mode"], ExecutionStrategy>> = {
  thorchain: { standard: "single", optimized: "streaming" },
  chainflip: { standard: "regular", optimized: "dca" },
  "near-intents": { standard: "solver", optimized: "solver" },
  maya: { standard: "single", optimized: "streaming" },
};

export function strategyFor(protocol: ProtocolId, request: Pick<BenchmarkRequest, "mode">) {
  return protocolStrategies[protocol][request.mode];
}
