const maxStoredResponseChars = 8_000;

type ResponseMetadata = {
  responseReceivedAt: string;
  responseHttpStatus: number;
  responseLatencyMs: number;
};

export type QuoteJsonResponse = ResponseMetadata & ({
  parsed: true;
  rawResponse: unknown;
} | {
  parsed: false;
  errorMessage: string;
  rawResponse: unknown;
});

function responsePreview(body: string, contentType: string | null) {
  return {
    contentType,
    body: body.slice(0, maxStoredResponseChars),
    truncated: body.length > maxStoredResponseChars,
  };
}

function responseSummary(body: string) {
  const summary = body.trim().replace(/\s+/g, " ");
  return summary ? summary.slice(0, 240) : "Empty response body";
}

export async function readQuoteJsonResponse(response: Response, startedAt: number, provider: string): Promise<QuoteJsonResponse> {
  let body: string;

  try {
    body = await response.text();
  } catch (error) {
    return {
      parsed: false,
      responseReceivedAt: new Date().toISOString(),
      responseHttpStatus: response.status,
      responseLatencyMs: Date.now() - startedAt,
      errorMessage: `${provider} response body could not be read (HTTP ${response.status}): ${error instanceof Error ? error.message : "Unknown body read error"}`,
      rawResponse: null,
    };
  }

  const metadata: ResponseMetadata = {
    responseReceivedAt: new Date().toISOString(),
    responseHttpStatus: response.status,
    responseLatencyMs: Date.now() - startedAt,
  };

  try {
    return { parsed: true, rawResponse: JSON.parse(body) as unknown, ...metadata };
  } catch {
    return {
      parsed: false,
      errorMessage: `${provider} returned a non-JSON response (HTTP ${response.status}): ${responseSummary(body)}`,
      rawResponse: responsePreview(body, response.headers.get("content-type")),
      ...metadata,
    };
  }
}
