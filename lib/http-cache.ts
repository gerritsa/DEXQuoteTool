type CloudflareCacheStorage = CacheStorage & { default: Cache };

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
    const cached = await defaultCache()?.match(new Request(request.url, { method: "GET" }));
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
      await cache.put(new Request(request.url, { method: "GET" }), response.clone());
    } catch {
      // Cache availability must never make a public API request fail.
    }
  }
  return response;
}
