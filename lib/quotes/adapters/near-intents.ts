import type { BenchmarkRequest, NormalizedQuote } from "../types";

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

  try {
    const response = await fetch("https://1click.chaindefuser.com/v0/quote", {
      method: "POST",
      signal,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
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
      }),
    });
    const rawResponse = await response.json() as NearQuoteResponse;
    const responseReceivedAt = new Date().toISOString();
    const quote = rawResponse.quote ?? rawResponse;
    const amountOut = quote.amountOut;

    if (!response.ok || typeof amountOut !== "string") {
      return { protocol, strategy, status: "error", requestStartedAt, responseReceivedAt, errorCode: `HTTP_${response.status}`, errorMessage: "NEAR Intents quote unavailable", rawResponse };
    }

    return {
      protocol,
      strategy,
      status: "quoted",
      expectedOutputBaseUnits: amountOut,
      expectedOutputFormatted: quote.amountOutFormatted,
      estimatedDurationSeconds: quote.timeEstimate,
      quoteExpiresAt: quote.deadline,
      requestStartedAt,
      responseReceivedAt,
      rawResponse,
    };
  } catch (error) {
    return { protocol, strategy, status: "error", requestStartedAt, responseReceivedAt: new Date().toISOString(), errorCode: "REQUEST_FAILED", errorMessage: error instanceof Error ? error.message : "Quote request failed", rawResponse: null };
  }
}
