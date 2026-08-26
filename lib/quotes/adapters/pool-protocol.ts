import { convertAtomicDecimals, formatBaseUnits } from "../amounts";
import { strategyFor } from "../protocols";
import type { BenchmarkRequest, NormalizedQuote, ProtocolId } from "../types";

type PoolProtocolId = Extract<ProtocolId, "thorchain" | "maya">;

const endpoints: Record<PoolProtocolId, string> = {
  thorchain: "https://gateway.liquify.com/chain/thorchain_api/thorchain/quote/swap",
  maya: "https://mayanode.mayachain.info/mayachain/quote/swap",
};

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
  url.searchParams.set("streaming_interval", "1");
  url.searchParams.set("streaming_quantity", request.mode === "optimized" ? "0" : "1");

  try {
    const started = Date.now();
    const response = await fetch(url, { signal, headers: { accept: "application/json" } });
    const rawResponse = await response.json() as Record<string, unknown>;
    const responseReceivedAt = new Date().toISOString();
    const responseLatencyMs = Date.now() - started;
    if (!response.ok) {
      const message = String(rawResponse.message ?? "Quote unavailable");
      const expectedUnavailable = response.status === 400 && /insufficient|no (?:pool|route|quote)|not supported|(?:min(?:imum)?|max(?:imum)?) (?:swap )?amount|dust threshold|amount (?:less than|exceeds)/i.test(message);
      return { protocol, strategy, status: expectedUnavailable ? "unavailable" : "error", requestStartedAt, responseReceivedAt, responseHttpStatus: response.status, responseLatencyMs, requestUrl: url.toString(), errorCode: expectedUnavailable ? "INSUFFICIENT_LIQUIDITY" : `HTTP_${response.status}`, errorMessage: message, rawResponse };
    }

    if (typeof rawResponse.expected_amount_out !== "string") {
      return { protocol, strategy, status: "error", requestStartedAt, responseReceivedAt, responseHttpStatus: response.status, responseLatencyMs, requestUrl: url.toString(), errorCode: "INVALID_RESPONSE", errorMessage: "Quote response omitted the expected output amount", rawResponse };
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
      responseHttpStatus: response.status,
      responseLatencyMs,
      requestUrl: url.toString(),
      rawResponse,
    };
  } catch (error) {
    return { protocol, strategy, status: "error", requestStartedAt, responseReceivedAt: new Date().toISOString(), requestUrl: url.toString(), errorCode: "REQUEST_FAILED", errorMessage: error instanceof Error ? error.message : "Quote request failed", rawResponse: null };
  }
}
