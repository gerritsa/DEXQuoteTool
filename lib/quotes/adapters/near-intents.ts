import type { BenchmarkRequest, NormalizedQuote } from "../types";
import { readQuoteJsonResponse } from "./response";

type NearQuoteResponse = {
  quote?: {
    amountIn?: string;
    amountOut?: string;
    amountOutFormatted?: string;
    deadline?: string;
    timeEstimate?: number;
  };
  amountOut?: string;
  amountOutFormatted?: string;
  deadline?: string;
  timeEstimate?: number;
  [key: string]: unknown;
};

function isNearQuoteResponse(value: unknown): value is NearQuoteResponse {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function responseMessage(value: unknown) {
  return isNearQuoteResponse(value) && typeof value.message === "string" ? value.message : undefined;
}

export async function getNearIntentsQuote(
  request: BenchmarkRequest,
  apiKey: string,
  signal?: AbortSignal,
): Promise<NormalizedQuote> {
  const protocol = "near-intents" as const;
  const strategy = "solver" as const;
  const requestStartedAt = new Date().toISOString();
  const originAsset = request.source.protocolIds[protocol];
  const destinationAsset = request.destination.protocolIds[protocol];

  if (!originAsset || !destinationAsset) {
    return { protocol, strategy, status: "unavailable", requestStartedAt, errorCode: "UNSUPPORTED_PAIR", rawResponse: null };
  }

  const url = "https://1click.chaindefuser.com/v0/quote";
  const payload = {
    dry: true,
    swapType: "EXACT_INPUT",
    slippageTolerance: request.slippageToleranceBps,
    originAsset,
    depositType: "ORIGIN_CHAIN",
    destinationAsset,
    amount: request.sourceAmountBaseUnits,
    recipient: request.recipient,
    recipientType: "DESTINATION_CHAIN",
    refundTo: request.refundAddress,
    refundType: "ORIGIN_CHAIN",
    deadline: new Date(Date.now() + 10 * 60_000).toISOString(),
    quoteWaitingTimeMs: 5_000,
  };

  const started = Date.now();

  try {
    const response = await fetch(url, {
      method: "POST",
      signal,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    });
    const result = await readQuoteJsonResponse(response, started, "NEAR Intents");
    const { responseReceivedAt, responseHttpStatus, responseLatencyMs, rawResponse } = result;

    if (!result.parsed) {
      return { protocol, strategy, status: "error", requestStartedAt, responseReceivedAt, responseHttpStatus, responseLatencyMs, requestUrl: url, requestPayload: payload, errorCode: response.ok ? "INVALID_RESPONSE" : `HTTP_${response.status}`, errorMessage: result.errorMessage, rawResponse };
    }

    if (!response.ok) {
      const message = responseMessage(rawResponse) ?? "NEAR Intents quote unavailable";
      const expectedUnavailable = response.status === 400 && /no liquidity|insufficient liquidity|no (?:route|quote)|not supported/i.test(message);
      return { protocol, strategy, status: expectedUnavailable ? "unavailable" : "error", requestStartedAt, responseReceivedAt, responseHttpStatus, responseLatencyMs, requestUrl: url, requestPayload: payload, errorCode: expectedUnavailable ? "INSUFFICIENT_LIQUIDITY" : `HTTP_${response.status}`, errorMessage: message, rawResponse };
    }

    if (!isNearQuoteResponse(rawResponse)) {
      return { protocol, strategy, status: "error", requestStartedAt, responseReceivedAt, responseHttpStatus, responseLatencyMs, requestUrl: url, requestPayload: payload, errorCode: "INVALID_RESPONSE", errorMessage: "NEAR Intents returned an unexpected JSON value", rawResponse };
    }

    const quote = rawResponse.quote ?? rawResponse;
    const amountOut = quote.amountOut;

    if (typeof amountOut !== "string") {
      return { protocol, strategy, status: "error", requestStartedAt, responseReceivedAt, responseHttpStatus, responseLatencyMs, requestUrl: url, requestPayload: payload, errorCode: "INVALID_RESPONSE", errorMessage: "NEAR Intents quote omitted the expected output amount", rawResponse };
    }

    return {
      protocol,
      strategy,
      status: "quoted",
      expectedOutputBaseUnits: amountOut,
      expectedOutputFormatted: quote.amountOutFormatted,
      estimatedDurationSeconds: quote.timeEstimate,
      quoteExpiresAt: quote.deadline ?? payload.deadline,
      requestStartedAt,
      responseReceivedAt,
      responseHttpStatus,
      responseLatencyMs,
      requestUrl: url,
      requestPayload: payload,
      rawResponse,
    };
  } catch (error) {
    return { protocol, strategy, status: "error", requestStartedAt, responseReceivedAt: new Date().toISOString(), responseLatencyMs: Date.now() - started, requestUrl: url, requestPayload: payload, errorCode: "REQUEST_FAILED", errorMessage: error instanceof Error ? error.message : "Quote request failed", rawResponse: null };
  }
}
