import { normalizeDashboardQuery, type DashboardQuery } from "./dashboard-query";
import SwapRankDashboard from "./swap-rank-dashboard";

export default async function Home({ searchParams }: { searchParams: Promise<DashboardQuery> }) {
  return <SwapRankDashboard view="leaderboard" initialQuery={normalizeDashboardQuery(await searchParams)} />;
}
