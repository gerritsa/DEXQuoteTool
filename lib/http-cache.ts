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
    return await defaultCache()?.match(new Request(request.url, { method: "GET" }));
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
