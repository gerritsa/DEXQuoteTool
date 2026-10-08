import { getD1 } from "../../../db";
import { env } from "cloudflare:workers";
import { readPublicCache, writePublicCache, publicCacheHeaders } from "../../../lib/http-cache";
import { historicalRoutes } from "../../../lib/routes/catalog";
import { buildVolumeWindow } from "../../../lib/volume/windows";
import { hourMs, volumePeriods, type VolumeDays } from "../../../lib/volume/model";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const routeId = url.searchParams.get("routeId")?.trim();
  const requestedDays = Number(url.searchParams.get("days") ?? 1);
  if (!routeId || !historicalRoutes().some((route) => route.id === routeId)) return Response.json({ error: "Unknown route" }, { status: 400 });
  if (![1, 7, 30].includes(requestedDays)) return Response.json({ error: "Period must be 1, 7 or 30 days" }, { status: 400 });
  if (!volumePeriods(env).includes(requestedDays as VolumeDays)) return Response.json({ error: "The 30-day volume view is temporarily disabled" }, { status: 400, headers: { "cache-control": "no-store" } });
  const days = requestedDays as VolumeDays;
  try {
    const cached = await readPublicCache(request);
    if (cached) return cached;
    const row = await getD1().prepare(`SELECT w.payload_json AS payloadJson, w.revision FROM route_volume_windows w
      JOIN volume_routes r ON r.id = w.route_key WHERE r.route_id = ? AND w.days = ?`)
      .bind(routeId, days).first<{ payloadJson: string; revision: string }>();
    if (!row || JSON.parse(row.payloadJson).schemaVersion !== 2 || Date.now() - Date.parse(JSON.parse(row.payloadJson).requestedEndAt) > 2 * hourMs) return Response.json(buildVolumeWindow(routeId, days, Math.floor(Date.now() / hourMs) * hourMs, [], [], []), { headers: { "cache-control": "no-store" } });
    const etag = `"${row.revision}"`;
    if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { etag, ...publicCacheHeaders(300) } });
    return writePublicCache(request, new Response(row.payloadJson, { headers: { "content-type": "application/json", etag, ...publicCacheHeaders(300) } }));
  } catch {
    return Response.json({ error: "Trading volume is not available yet" }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
