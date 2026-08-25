import { formatBaseUnits } from "../amounts";
import type { BenchmarkRequest, NormalizedQuote } from "../types";

type ChainflipQuote = {
  egressAmount?: string;
  estimatedDurationSeconds?: number;
  type?: "REGULAR" | "DCA";
  [key: string]: unknown;
};

function splitAsset(value: string) {
  const separator = value.indexOf(":");
  if (separator < 1) throw new Error(`Invalid Chainflip asset ID: ${value}`);
  return { chain: value.slice(0, separator), asset: value.slice(separator + 1) };
}

export async function getChainflipQuote(request: BenchmarkRequest, signal?: AbortSignal): Promise<NormalizedQuote> {
  const protocol = "chainflip" as const;
  const requestedStrategy = request.mode === "optimized" ? "dca" as const : "regular" as const;
  const requestStartedAt = new Date().toISOString();
  const sourceId = request.source.protocolIds[protocol];
  const destinationId = request.destination.protocolIds[protocol];

  if (!sourceId || !destinationId) {
    return { protocol, strategy: requestedStrategy, status: "unavailable", requestStartedAt, errorCode: "UNSUPPORTED_PAIR", rawResponse: null };
  }

  const source = splitAsset(sourceId);
  const destination = splitAsset(destinationId);
  const url = new URL("https://chainflip-swap.chainflip.io/v2/quote");
  url.searchParams.set("amount", request.sourceAmountBaseUnits);
  url.searchParams.set("srcChain", source.chain);
  url.searchParams.set("srcAsset", source.asset);
  url.searchParams.set("destChain", destination.chain);
  url.searchParams.set("destAsset", destination.asset);
  url.searchParams.set("isVaultSwap", "false");
  url.searchParams.set("isOnChain", "false");
  url.searchParams.set("dcaV2Enabled", String(request.mode === "optimized"));

  try {
    const started = Date.now();
    const response = await fetch(url, { signal, headers: { accept: "application/json", "X-Chainflip-Sdk-Version": "2.2.1" } });
    const rawResponse = await response.json() as ChainflipQuote[] | Record<string, unknown>;
    const responseReceivedAt = new Date().toISOString();
    const responseLatencyMs = Date.now() - started;
    const quotes = Array.isArray(rawResponse) ? rawResponse : [];
    const requestedType = request.mode === "optimized" ? "DCA" : "REGULAR";
    const quote = quotes.find((candidate) => candidate.type === requestedType)
      ?? (request.mode === "optimized" ? quotes.find((candidate) => candidate.type === "REGULAR") : undefined);
    const strategy = quote?.type === "DCA" ? "dca" as const : quote?.type === "REGULAR" ? "regular" as const : requestedStrategy;

    if (!response.ok || !quote || typeof quote.egressAmount !== "string") {
      return {
        protocol,
        strategy,
        status: "error",
        requestStartedAt,
        responseReceivedAt,
        responseHttpStatus: response.status,
        responseLatencyMs,
        requestUrl: url.toString(),
        errorCode: response.ok ? `HTTP_${response.status}_NO_USABLE_QUOTE` : `HTTP_${response.status}`,
        errorMessage: "Chainflip quote unavailable",
        rawResponse,
      };
    }

    return {
      protocol,
      strategy,
      status: "quoted",
      expectedOutputBaseUnits: quote.egressAmount,
      expectedOutputFormatted: formatBaseUnits(quote.egressAmount, request.destination.decimals),
      estimatedDurationSeconds: quote.estimatedDurationSeconds,
      requestStartedAt,
      responseReceivedAt,
      responseHttpStatus: response.status,
      responseLatencyMs,
      requestUrl: url.toString(),
      rawResponse,
    };
  } catch (error) {
    return {
      protocol,
      strategy,
      status: "error",
      requestStartedAt,
      responseReceivedAt: new Date().toISOString(),
      requestUrl: url.toString(),
      errorCode: "REQUEST_FAILED",
      errorMessage: error instanceof Error ? error.message : "Quote request failed",
      rawResponse: null,
    };
  }
}
