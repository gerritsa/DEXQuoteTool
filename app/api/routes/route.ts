import { fixedRouteSet, getCatalog, routesFromAssets, topThorRoutes } from "../../../lib/routes/catalog";
import { quoteSizes } from "../../../lib/quotes/sizes";

export async function GET() {
  try {
    const catalog = await getCatalog();
    const allRoutes = routesFromAssets(catalog.assets);
    const comparableRoutes = allRoutes.filter((route) => route.partners.length > 1);
    const topRoutes = topThorRoutes(catalog.assets);
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
        filteredRoutes: topRoutes.length,
        partnerRouteCounts,
        scheduledRequests: topRoutes.reduce((total, route) => total + route.partners.length * quoteSizes.length, 0),
      },
      routeSet: fixedRouteSet,
      ranking: { metric: fixedRouteSet.metric, description: fixedRouteSet.description },
      routes: topRoutes,
      page: 1,
      pages: 1,
    }, { headers: { "cache-control": "public, max-age=60, s-maxage=300" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Route catalog unavailable" }, { status: 503 });
  }
}
