import { normalizeDashboardQuery, type DashboardQuery } from "../dashboard-query";
import SwapRankDashboard from "../swap-rank-dashboard";

export default async function RoutePickerPage({ searchParams }: { searchParams: Promise<DashboardQuery> }) {
  return <SwapRankDashboard key="analysis-picker" view="analysis" initialQuery={normalizeDashboardQuery(await searchParams)} />;
}
