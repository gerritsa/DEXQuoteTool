import { normalizeDashboardQuery, type DashboardQuery } from "../../dashboard-query";
import SwapRankDashboard from "../../swap-rank-dashboard";

export default async function RouteAnalysisPage({
  params,
  searchParams,
}: {
  params: Promise<{ routeId: string }>;
  searchParams: Promise<DashboardQuery>;
}) {
  const [{ routeId }, query] = await Promise.all([params, searchParams]);
  let decodedRouteId = routeId;
  try {
    decodedRouteId = decodeURIComponent(routeId);
  } catch {
    // Leave malformed route ids untouched so the client can show its not-found state.
  }
  return <SwapRankDashboard view="analysis" initialRouteId={decodedRouteId} initialQuery={normalizeDashboardQuery(query)} />;
}
