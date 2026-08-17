import { getCatalog, topThorRoutes } from "../../../lib/routes/catalog";

export async function GET() {
  try {
    const catalog = await getCatalog();
    const topRoutes = topThorRoutes(catalog.assets);

    return Response.json({
      routes: topRoutes,
    }, { headers: { "cache-control": "public, max-age=60, s-maxage=300" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Route catalog unavailable" }, { status: 503 });
  }
}
