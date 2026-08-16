import { getCatalog, routesFromAssets } from "../../../lib/routes/catalog";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const search = (url.searchParams.get("search") ?? "").trim().toLowerCase();
    const catalog = await getCatalog();
    const allRoutes = routesFromAssets(catalog.assets);
    const comparableRoutes = allRoutes.filter((route) => route.partners.length > 1);
    const topRoutes = allRoutes
      .filter((route) => route.popularityScore > 0)
      .sort((a, b) => b.popularityScore - a.popularityScore)
      .slice(0, 20);
    const filtered = search
      ? topRoutes.filter((route) => `${route.source.label} ${route.destination.label}`.toLowerCase().includes(search))
      : topRoutes;
    const partnerRouteCounts = Object.fromEntries(
      ["thorchain", "chainflip", "near-intents", "maya"].map((partner) => [partner, allRoutes.filter((route) => route.partners.includes(partner as never)).length])
    );

    return Response.json({
      generatedAt: catalog.generatedAt,
      statuses: catalog.statuses,
      counts: {
        thorAssets: catalog.assets.length,
        allRoutes: allRoutes.length,
        comparableRoutes: comparableRoutes.length,
        scheduledRoutes: topRoutes.length,
        filteredRoutes: filtered.length,
        partnerRouteCounts,
        scheduledRequests: topRoutes.reduce((total, route) => total + route.partners.length * 8, 0),
      },
      ranking: { metric: "geometric_mean_pool_volume_24h", description: "Ranked by the geometric mean of each route asset's trailing 24-hour THORChain pool volume." },
      routes: filtered,
      page: 1,
      pages: 1,
    }, { headers: { "cache-control": "public, max-age=60, s-maxage=300" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Route catalog unavailable" }, { status: 503 });
  }
}
