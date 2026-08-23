import { getCatalog, topThorRoutes } from "../../../lib/routes/catalog";
import { publicCacheHeaders, readPublicCache, writePublicCache } from "../../../lib/http-cache";

export async function GET(request: Request) {
  try {
    const cached = await readPublicCache(request);
    if (cached) return cached;
    const catalog = await getCatalog();
    const topRoutes = topThorRoutes(catalog.assets);

    return writePublicCache(request, Response.json({
      routes: topRoutes,
    }, { headers: publicCacheHeaders(300) }));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Route catalog unavailable" }, { status: 503 });
  }
}
