import { env } from "cloudflare:workers";
import { normalizeDashboardQuery, type DashboardQuery } from "../dashboard-query";
import SwapRankDashboard from "../swap-rank-dashboard";

export default async function VolumeInsightsPage({ searchParams }: { searchParams: Promise<DashboardQuery> }) {
  const query = await searchParams;
  const routeId = Array.isArray(query.routeId) ? query.routeId[0] : query.routeId;
  const volume30DaysEnabled = env.VOLUME_30D_ENABLED === "true";
  const initialQuery = normalizeDashboardQuery(query);
  if (!volume30DaysEnabled && initialQuery.volumeDays === 30) initialQuery.volumeDays = 1;
  return <SwapRankDashboard key={`volume-${routeId ?? "picker"}`} view="volume" initialRouteId={routeId} initialQuery={initialQuery} volume30DaysEnabled={volume30DaysEnabled} />;
}
