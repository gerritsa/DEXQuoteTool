import { getD1 } from "../../../db";
import { getCatalog, topThorRoutes } from "../../../lib/routes/catalog";
import { publicCacheHeaders, readPublicCache, writePublicCache } from "../../../lib/http-cache";

export async function GET(request: Request) {
  try {
    const cached = await readPublicCache(request);
    if (cached) return cached;
    const catalog = await getCatalog({ d1: getD1(), allowStale: true, allowStatic: true });
    const topRoutes = topThorRoutes(catalog.assets);

    return writePublicCache(request, Response.json({
      routes: topRoutes,
      catalog: {
        status: catalog.source === "live" ? "fresh" : "stale",
        source: catalog.source,
        refreshedAt: catalog.refreshedAt,
        warning: catalog.warning,
      },
    }, { headers: publicCacheHeaders(300) }));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Route catalog unavailable" }, { status: 503 });
  }
}
