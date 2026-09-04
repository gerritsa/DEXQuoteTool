type CloudflareCacheStorage = CacheStorage & { default: Cache };

const comparableProtocols = ["near-intents", "chainflip", "thorchain"];

function normalizedMode(url: URL) {
  return url.searchParams.get("mode") === "optimized" ? "optimized" : "standard";
}

function normalizedProtocols(url: URL) {
  const requested = (url.searchParams.get("protocols") ?? "").split(",");
  const selected = comparableProtocols.filter((protocol) => requested.includes(protocol));
  return (selected.length >= 2 ? selected : comparableProtocols).join(",");
}

function replaceSearch(url: URL, entries: Array<[string, string]>) {
  url.search = "";
  for (const [key, value] of entries) {
    if (value) url.searchParams.set(key, value);
  }
  return url;
}

export function canonicalPublicCacheUrl(request: Request) {
  const url = new URL(request.url);
  if (url.pathname === "/api/routes") return replaceSearch(url, []).toString();
  if (url.pathname === "/api/comparison") {
    const requestedWindow = url.searchParams.get("window") ?? "now";
    const window = ["now", "7d", "14d", "30d"].includes(requestedWindow) ? requestedWindow : "now";
    return replaceSearch(url, [
      ["window", window],
      ["mode", normalizedMode(url)],
      ["protocols", normalizedProtocols(url)],
    ]).toString();
  }
  if (url.pathname === "/api/runs") {
    const requestedRunId = Number(url.searchParams.get("runId"));
    if (Number.isInteger(requestedRunId) && requestedRunId > 0) {
      return replaceSearch(url, [["schema", "4"], ["runId", String(requestedRunId)]]).toString();
    }
    return replaceSearch(url, [
      ["schema", "4"],
      ["routeId", url.searchParams.get("routeId")?.trim() ?? ""],
      ["amountId", url.searchParams.get("amountId")?.trim() ?? ""],
      ["mode", normalizedMode(url)],
    ]).toString();
  }
  if (url.pathname === "/api/trends") {
    const requestedDays = Number(url.searchParams.get("days") ?? 1);
    const days = [1, 7, 14, 30].includes(requestedDays) ? String(requestedDays) : "1";
    return replaceSearch(url, [
      ["routeId", url.searchParams.get("routeId")?.trim() ?? ""],
      ["amountId", url.searchParams.get("amountId")?.trim() ?? ""],
      ["mode", normalizedMode(url)],
      ["days", days],
      ["protocols", normalizedProtocols(url)],
    ]).toString();
  }
  return url.toString();
}

function publicCacheKey(request: Request) {
  return new Request(canonicalPublicCacheUrl(request), { method: "GET" });
}

function defaultCache() {
  return (globalThis.caches as CloudflareCacheStorage | undefined)?.default;
}

export function publicCacheHeaders(maxAgeSeconds: number) {
  return {
    "cache-control": `public, max-age=${Math.min(maxAgeSeconds, 60)}, s-maxage=${maxAgeSeconds}, stale-while-revalidate=${maxAgeSeconds * 2}`,
  };
}

export async function readPublicCache(request: Request) {
  if (request.method !== "GET") return undefined;
  try {
    const cached = await defaultCache()?.match(publicCacheKey(request));
    if (!cached) return undefined;

    // Responses returned directly by Cloudflare Cache can have immutable
    // headers. Vinext adds framework headers after the route handler returns,
    // so return a fresh Response with mutable headers instead.
    return new Response(cached.body, {
      status: cached.status,
      statusText: cached.statusText,
      headers: cached.headers,
    });
  } catch {
    return undefined;
  }
}

export async function writePublicCache(request: Request, response: Response) {
  const cache = defaultCache();
  if (cache && request.method === "GET" && response.ok) {
    try {
      await cache.put(publicCacheKey(request), response.clone());
    } catch {
      // Cache availability must never make a public API request fail.
    }
  }
  return response;
}
