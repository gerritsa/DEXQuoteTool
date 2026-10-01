import type { ExecutionMode, ExecutionStrategy, ProtocolId } from "./types";

export const bestOutputMode: ExecutionMode = "optimized";

const protocolStrategies: Record<ProtocolId, ExecutionStrategy> = {
  thorchain: "streaming",
  chainflip: "dca",
  "near-intents": "solver",
  maya: "streaming",
};

export function strategyFor(protocol: ProtocolId) {
  return protocolStrategies[protocol];
}
