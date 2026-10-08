import { env } from "cloudflare:workers";
import { getD1 } from "../../../db";
import { hourMs, volumePageBudget, volumePeriods } from "../../../lib/volume/model";

export async function GET() {
  if (env.VOLUME_COLLECTION_ENABLED !== "true") return Response.json({ status: "disabled" }, { headers: { "cache-control": "no-store" } });
  try {
    const d1 = getD1();
    const now = Date.now();
    const cutoff = Math.floor(now / hourMs) * hourMs;
    const [state, hours, readiness] = await Promise.all([
      d1.prepare(`SELECT protocol, budget_day AS budgetDay, pages_today AS pagesToday, background_pages_today AS backgroundPagesToday,
        last_error AS lastError, updated_at AS updatedAt FROM volume_ingestion_state`).all(),
      d1.prepare(`SELECT protocol, COUNT(*) AS trackedHours,
        SUM(staged_rows) AS stagedSwaps,
        SUM(CASE WHEN status = 'complete' THEN 1 ELSE 0 END) AS completeHours,
        SUM(CASE WHEN failures >= 6 THEN 1 ELSE 0 END) AS pausedHours,
        MAX(CASE WHEN status = 'complete' THEN hour END) AS latestHour
        FROM volume_feed_hours GROUP BY protocol`).all(),
      d1.prepare(`SELECT COUNT(*) AS hours FROM (SELECT hour FROM volume_feed_hours
        WHERE hour >= ? AND hour < ? AND status='complete' GROUP BY hour HAVING COUNT(DISTINCT protocol)=4)`)
        .bind(cutoff - 30 * 24 * hourMs, cutoff).first<{ hours: number }>(),
    ]);
    const degraded = state.results.length < 4 || state.results.some((row) => row.lastError) || hours.results.some((row) =>
      !row.latestHour || Date.now() - Number(row.latestHour) - 3_600_000 > 2 * 3_600_000 || Number(row.pausedHours) > 0);
    return Response.json({ status: degraded ? "degraded" : "healthy", checkedAt: new Date().toISOString(),
      dailyPageLimit: volumePageBudget(env, now).limit, pageBudget: volumePageBudget(env, now), enabledPeriods: volumePeriods(env),
      stagedSwapLimitPerProvider: 100000, liveStagingReserve: 25000,
      thirtyDayReadiness: { enabled: env.VOLUME_30D_ENABLED === "true", sharedHours: readiness?.hours ?? 0, requiredHours: 720, ready: readiness?.hours === 720 },
      sources: state.results, history: hours.results },
    { status: degraded ? 503 : 200, headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ status: "initializing", error: "Volume migrations or collection are not ready" }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
