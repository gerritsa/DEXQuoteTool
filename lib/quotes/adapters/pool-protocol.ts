import { convertAtomicDecimals, formatBaseUnits } from "../amounts";
import { strategyFor } from "../protocols";
import type { BenchmarkRequest, NormalizedQuote, ProtocolId } from "../types";
import { readQuoteJsonResponse } from "./response";

type PoolProtocolId = Extract<ProtocolId, "thorchain" | "maya">;

const endpoints: Record<PoolProtocolId, string> = {
  thorchain: "https://gateway.liquify.com/chain/thorchain_api/thorchain/quote/swap",
  maya: "https://mayanode.mayachain.info/mayachain/quote/swap",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function responseMessage(value: unknown) {
  return isRecord(value) && typeof value.message === "string" ? value.message : undefined;
}

export async function getPoolProtocolQuote(
  protocol: PoolProtocolId,
  request: BenchmarkRequest,
  signal?: AbortSignal,
): Promise<NormalizedQuote> {
  const requestStartedAt = new Date().toISOString();
  const strategy = strategyFor(protocol, request);
  const fromAsset = request.source.protocolIds[protocol];
  const toAsset = request.destination.protocolIds[protocol];

  if (!fromAsset || !toAsset) {
    return { protocol, strategy, status: "unavailable", requestStartedAt, errorCode: "UNSUPPORTED_PAIR", rawResponse: null };
  }

  const url = new URL(endpoints[protocol]);
  url.searchParams.set("from_asset", fromAsset);
  url.searchParams.set("to_asset", toAsset);
  url.searchParams.set("amount", convertAtomicDecimals(request.sourceAmountBaseUnits, request.source.decimals, 8));
  url.searchParams.set("liquidity_tolerance_bps", String(request.slippageToleranceBps));
  const streamingInterval = protocol === "thorchain" && request.mode === "optimized" ? "0" : "1";
  url.searchParams.set("streaming_interval", streamingInterval);
  url.searchParams.set("streaming_quantity", request.mode === "optimized" ? "0" : "1");

  const started = Date.now();

  try {
    const response = await fetch(url, { signal, headers: { accept: "application/json" } });
    const result = await readQuoteJsonResponse(response, started, protocol === "thorchain" ? "THORChain" : "Maya");
    const { responseReceivedAt, responseHttpStatus, responseLatencyMs, rawResponse } = result;

    if (!result.parsed) {
      return { protocol, strategy, status: "error", requestStartedAt, responseReceivedAt, responseHttpStatus, responseLatencyMs, requestUrl: url.toString(), errorCode: response.ok ? "INVALID_RESPONSE" : `HTTP_${response.status}`, errorMessage: result.errorMessage, rawResponse };
    }

    if (!response.ok) {
      const message = responseMessage(rawResponse) ?? "Quote unavailable";
      const expectedUnavailable = response.status === 400 && /insufficient|no (?:pool|route|quote)|not supported|(?:min(?:imum)?|max(?:imum)?) (?:swap )?amount|dust threshold|amount (?:less than|exceeds)|trading (?:is )?(?:halted|paused)|chain (?:is )?(?:halted|paused)/i.test(message);
      return { protocol, strategy, status: expectedUnavailable ? "unavailable" : "error", requestStartedAt, responseReceivedAt, responseHttpStatus, responseLatencyMs, requestUrl: url.toString(), errorCode: expectedUnavailable ? "INSUFFICIENT_LIQUIDITY" : `HTTP_${response.status}`, errorMessage: message, rawResponse };
    }

    if (!isRecord(rawResponse)) {
      return { protocol, strategy, status: "error", requestStartedAt, responseReceivedAt, responseHttpStatus, responseLatencyMs, requestUrl: url.toString(), errorCode: "INVALID_RESPONSE", errorMessage: "Quote endpoint returned an unexpected JSON value", rawResponse };
    }

    if (typeof rawResponse.expected_amount_out !== "string") {
      return { protocol, strategy, status: "error", requestStartedAt, responseReceivedAt, responseHttpStatus, responseLatencyMs, requestUrl: url.toString(), errorCode: "INVALID_RESPONSE", errorMessage: "Quote response omitted the expected output amount", rawResponse };
    }

    const inboundSeconds = Number(rawResponse.inbound_confirmation_seconds ?? 0);
    const outboundSeconds = Number(rawResponse.outbound_delay_seconds ?? 0);
    const streamingSeconds = Number(rawResponse.streaming_swap_seconds ?? 0);
    const totalSeconds = Number(rawResponse.total_swap_seconds);
    const hasTotalSeconds = rawResponse.total_swap_seconds != null && Number.isFinite(totalSeconds) && totalSeconds >= 0;
    return {
      protocol,
      strategy,
      status: "quoted",
      expectedOutputBaseUnits: rawResponse.expected_amount_out,
      expectedOutputFormatted: formatBaseUnits(rawResponse.expected_amount_out, 8),
      estimatedDurationSeconds: hasTotalSeconds
        ? totalSeconds
        : inboundSeconds + outboundSeconds + streamingSeconds,
      requestStartedAt,
      responseReceivedAt,
      quoteExpiresAt: typeof rawResponse.expiry === "number" ? new Date(rawResponse.expiry * 1000).toISOString() : undefined,
      responseHttpStatus,
      responseLatencyMs,
      requestUrl: url.toString(),
      rawResponse,
    };
  } catch (error) {
    return { protocol, strategy, status: "error", requestStartedAt, responseReceivedAt: new Date().toISOString(), responseLatencyMs: Date.now() - started, requestUrl: url.toString(), errorCode: "REQUEST_FAILED", errorMessage: error instanceof Error ? error.message : "Quote request failed", rawResponse: null };
  }
}
