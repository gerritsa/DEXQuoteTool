import { historicalRoutes, type PartnerId, type CatalogAsset } from "../routes/catalog";
import { fetchVolumePage, FeedError, type FeedEnvironment } from "./adapters";
import { addEvent, emptyTotals, hourMs, scoreQuotes, volumeProtocols, volumeRetentionDays, volumePageBudget, volumePeriods, type VolumeBudgetConfig, type QuoteHour, type VolumeTotals } from "./model";
import { buildVolumeWindow, type HourCoverage, type HourQuotes, type HourTotal } from "./windows";

export type VolumeJob = { kind: "volume-collect"; protocol: PartnerId } | { kind: "volume-publish"; routeIds: string[]; cutoff: number };
export type VolumeEnvironment = FeedEnvironment & VolumeBudgetConfig & { DB: D1Database; ARCHIVE: R2Bucket; VOLUME_QUEUE?: Queue<VolumeJob>; VOLUME_COLLECTION_ENABLED?: string; VOLUME_30D_ENABLED?: string };
type FeedHour = { id: string; hour: number; status: string; generation: number; cursor: string | null; pages: number; records: number; failures: number };
type StageRow = { id: string; routeKey: number; usdMicros: string | null; pending: number };
const routes = historicalRoutes();
const maxPagesPerHour = 200;
const maxTrackedSwapsPerHour = 10_000;
const maxStagedSwapsPerProvider = 100_000;
const liveStagingReserve = 25_000;
class LostLease extends Error {}
async function assertLease(d1: D1Database, protocol: PartnerId, lease: string) {
  if (!await d1.prepare("SELECT protocol FROM volume_ingestion_state WHERE protocol = ? AND lease = ?").bind(protocol, lease).first()) throw new LostLease();
}

export async function volumeRouteKeys(d1: D1Database) {
  const rows = await d1.prepare("SELECT id, route_id AS routeId FROM volume_routes").all<{ id: number; routeId: string }>();
  return new Map(rows.results.map((row) => [row.routeId, row.id]));
}

async function seed(d1: D1Database, cutoff: number, horizonDays: number) {
  await d1.batch(routes.map((route) => d1.prepare("INSERT OR IGNORE INTO volume_routes (route_id) VALUES (?)").bind(route.id)));
  for (const protocol of volumeProtocols) {
    await d1.prepare("INSERT OR IGNORE INTO volume_ingestion_state (protocol) VALUES (?)").bind(protocol).run();
    // Paused long-range views must not continue consuming backfill capacity.
    await d1.prepare(`WITH RECURSIVE hours(h) AS (
      SELECT ? UNION ALL SELECT h + ? FROM hours WHERE h + ? < ?
    ) INSERT OR IGNORE INTO volume_feed_hours (id, protocol, hour)
    SELECT ? || ':' || CAST(h AS INTEGER), ?, CAST(h AS INTEGER) FROM hours`).bind(cutoff - horizonDays * 24 * hourMs, hourMs, hourMs, cutoff, protocol, protocol).run();
  }
}

export async function enqueueVolumeCollection(time: number, environment: VolumeEnvironment) {
  if (environment.VOLUME_COLLECTION_ENABLED !== "true" || !environment.VOLUME_QUEUE) return;
  const cutoff = Math.floor(time / hourMs) * hourMs;
  await seed(environment.DB, cutoff, Math.max(...volumePeriods(environment)));
  const messages: Array<{ body: VolumeJob; contentType: "json" }> = volumeProtocols.map((protocol) => ({ body: { kind: "volume-collect", protocol }, contentType: "json" }));
  for (let index = 0; index < routes.length; index += 5) messages.push({ body: { kind: "volume-publish", routeIds: routes.slice(index, index + 5).map((route) => route.id), cutoff }, contentType: "json" });
  await environment.VOLUME_QUEUE.sendBatch(messages);
}

// Compact quote summaries can be reconstructed from the existing 32-day
// four-hour trend archive without extending raw benchmark retention.
async function refreshQuoteRange(d1: D1Database, hour: number, keys: Map<string, number>) {
  const start = Math.floor(hour / (4 * hourMs)) * 4 * hourMs;
  const rows = await d1.prepare(`SELECT pair_id AS routeId, amount_id AS amountId, samples_json AS samplesJson
    FROM trend_buckets WHERE mode = 'optimized' AND bucket_seconds = 14400 AND bucket_start = ?`)
    .bind(new Date(start).toISOString()).all<{ routeId: string; amountId: string; samplesJson: string }>();
  const byRoute = new Map<string, QuoteHour>();
  for (const row of rows.results) {
    if (!keys.has(row.routeId)) continue;
    const runs = JSON.parse(row.samplesJson) as Array<{ initiatedAt: string; quotes: Array<{ protocol: PartnerId; output: number }> }>;
    for (const run of runs) {
      const timestamp = Date.parse(run.initiatedAt);
      if (timestamp < hour || timestamp >= hour + hourMs) continue;
      const scores = scoreQuotes(run.quotes);
      const result = byRoute.get(row.routeId) ?? {};
      const size = result[row.amountId] ??= {};
      for (const protocol of volumeProtocols) {
        const source = scores[protocol]!;
        const target = size[protocol] ??= { wins: 0, samples: 0, successes: 0, competing: 0 };
        for (const key of ["wins", "samples", "successes", "competing"] as const) target[key] += source[key];
      }
      byRoute.set(row.routeId, result);
    }
  }
  if (byRoute.size) await d1.batch(Array.from(byRoute, ([routeId, scores]) => d1.prepare(`
    INSERT INTO route_quote_hourly (id, route_key, hour, scores_json, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET scores_json = excluded.scores_json, updated_at = excluded.updated_at
  `).bind(`${keys.get(routeId)}:${hour}`, keys.get(routeId), hour, JSON.stringify(scores), new Date().toISOString())));
}

export async function refreshVolumeQuoteHour(time: number, environment: VolumeEnvironment) {
  if (environment.VOLUME_COLLECTION_ENABLED !== "true") return;
  const keys = await volumeRouteKeys(environment.DB);
  if (keys.size) await refreshQuoteRange(environment.DB, Math.floor(time / hourMs) * hourMs, keys);
}

export async function publishRouteWindows(routeIds: string[], cutoff: number, environment: VolumeEnvironment) {
  const d1 = environment.DB;
  const periods = volumePeriods(environment);
  const horizonStart = cutoff - Math.max(...periods) * 24 * hourMs;
  const keys = await volumeRouteKeys(d1);
  const coverage = await d1.prepare(`SELECT protocol, hour, status, updated_at AS updatedAt FROM volume_feed_hours
    WHERE hour >= ? AND hour < ? AND status = 'complete'`).bind(horizonStart, cutoff).all<HourCoverage>();
  const state = await d1.prepare("SELECT protocol, last_error AS lastError FROM volume_ingestion_state").all<{ protocol: PartnerId; lastError: string | null }>();
  const errors = Object.fromEntries(state.results.map((row) => [row.protocol, row.lastError]));
  const catalog = await d1.prepare("SELECT assets_json AS assetsJson FROM catalog_state WHERE id = 'primary'").first<{ assetsJson: string | null }>().catch(() => null);
  let catalogAssets: CatalogAsset[] = [];
  try { catalogAssets = JSON.parse(catalog?.assetsJson ?? "[]") as CatalogAsset[]; } catch { catalogAssets = []; }
  const catalogByAsset = new Map(catalogAssets.map((asset) => [asset.thorAsset, asset]));
  const now = new Date().toISOString();
  for (const routeId of routeIds) {
    const routeKey = keys.get(routeId);
    if (!routeKey) continue;
    const route = routes.find((entry) => entry.id === routeId)!;
    const source = catalogByAsset.get(route.source.thorAsset), destination = catalogByAsset.get(route.destination.thorAsset);
    const supported = source && destination ? volumeProtocols.filter((protocol) => source.support[protocol].source && destination.support[protocol].destination) : route.partners;
    const [totals, quotes] = await Promise.all([
      d1.prepare(`SELECT protocol, hour, totals_json AS totalsJson, updated_at AS updatedAt FROM volume_hourly
        WHERE route_key = ? AND hour >= ? AND hour < ?`).bind(routeKey, horizonStart, cutoff).all<HourTotal>(),
      d1.prepare(`SELECT hour, scores_json AS scoresJson FROM route_quote_hourly
        WHERE route_key = ? AND hour >= ? AND hour < ?`).bind(routeKey, horizonStart, cutoff).all<HourQuotes>(),
    ]);
    await d1.batch(periods.map((days) => {
      const payload = buildVolumeWindow(routeId, days, cutoff, totals.results, coverage.results, quotes.results, errors, supported);
      return d1.prepare(`INSERT INTO route_volume_windows (id, route_key, days, payload_json, revision, updated_at)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json,
        revision = excluded.revision, updated_at = excluded.updated_at WHERE excluded.updated_at >= route_volume_windows.updated_at`)
        .bind(`${routeKey}:${days}`, routeKey, days, JSON.stringify(payload), `${cutoff}:${now}`, now);
    }));
  }
}

async function finalizeHour(job: FeedHour, protocol: PartnerId, lease: string, environment: VolumeEnvironment) {
  const d1 = environment.DB;
  await assertLease(d1, protocol, lease);
  const rows = await d1.prepare(`SELECT id, route_key AS routeKey, usd_micros AS usdMicros, pending
    FROM volume_recent_swaps WHERE job_id = ? AND generation = ? LIMIT ?`)
    .bind(job.id, job.generation, maxTrackedSwapsPerHour + 1).all<StageRow>();
  if (rows.results.length > maxTrackedSwapsPerHour) throw new FeedError("Tracked hourly swaps exceeded the configured storage budget", 3600);
  const totals = new Map<number, VolumeTotals>();
  for (const row of rows.results) {
    const value = totals.get(row.routeKey) ?? emptyTotals();
    addEvent(value, { usdMicros: row.usdMicros, pending: Boolean(row.pending) });
    totals.set(row.routeKey, value);
  }
  const now = new Date().toISOString();
  const pendingCount = rows.results.filter((row) => row.pending).length;
  const repairHours = [3, 24, 72];
  const nextRepair = pendingCount ? Date.now() + 3 * hourMs
    : Date.now() >= job.hour + 73 * hourMs || job.generation > repairHours.length ? Number.MAX_SAFE_INTEGER
      : job.hour + (1 + repairHours[job.generation - 1]) * hourMs;
  const archive = JSON.stringify({ protocol, hour: job.hour, generation: job.generation, events: rows.results, totals: Array.from(totals) });
  const compressed = new Blob([archive]).stream().pipeThrough(new CompressionStream("gzip"));
  // R2 requires a body with known length; arbitrary compressed streams fail.
  const bytes = await new Response(compressed).arrayBuffer();
  await environment.ARCHIVE.put(`volume/normalized/${protocol}/${job.hour}/${job.generation}-${lease}.json.gz`, bytes, { httpMetadata: { contentType: "application/gzip" } });
  const guard = "EXISTS (SELECT 1 FROM volume_ingestion_state WHERE protocol = ? AND lease = ?)";
  const statements = [d1.prepare(`DELETE FROM volume_hourly WHERE protocol = ? AND hour = ? AND ${guard}`).bind(protocol, job.hour, protocol, lease)];
  for (const [routeKey, value] of totals) statements.push(d1.prepare(`
    INSERT INTO volume_hourly (id, route_key, protocol, hour, totals_json, updated_at)
    SELECT ?, ?, ?, ?, ?, ? WHERE ${guard}
    ON CONFLICT(id) DO UPDATE SET totals_json = excluded.totals_json, updated_at = excluded.updated_at
  `).bind(`${routeKey}:${protocol}:${job.hour}`, routeKey, protocol, job.hour, JSON.stringify(value), now, protocol, lease));
  statements.push(d1.prepare(`UPDATE volume_feed_hours SET status = 'complete', cursor = NULL, pending = ?, staged_rows = ?,
    updated_at = ?, last_error = NULL, failures = 0, next_attempt = ? WHERE id = ? AND generation = ? AND ${guard}`)
    .bind(pendingCount, rows.results.length, now, nextRepair, job.id, job.generation, protocol, lease));
  await d1.batch(statements);
  await assertLease(d1, protocol, lease);
  const quoteHour = await d1.prepare("SELECT id FROM route_quote_hourly WHERE hour = ? LIMIT 1").bind(job.hour).first();
  if (!quoteHour) await refreshQuoteRange(d1, job.hour, await volumeRouteKeys(d1));
}

export async function collectVolume(protocol: PartnerId, environment: VolumeEnvironment) {
  const d1 = environment.DB;
  const now = Date.now();
  const lease = crypto.randomUUID();
  const claim = await d1.prepare(`UPDATE volume_ingestion_state SET lease = ?, lease_until = ?
    WHERE protocol = ? AND lease_until < ? AND next_request <= ?`).bind(lease, now + 90_000, protocol, now, now).run();
  if (!claim.meta.changes) return;
  let job: FeedHour | null = null;
  let continuation = false;
  // Queue delays are whole seconds; round past NEAR's 5.1-second pacing guard.
  let delay = protocol === "near-intents" ? 6 : 5;
  try {
    const cutoff = Math.floor(now / hourMs) * hourMs;
    const pageBudget = volumePageBudget(environment, now);
    const day = Math.floor(now / (24 * hourMs));
    const usage = await d1.prepare("SELECT budget_day AS day, pages_today AS pages, background_pages_today AS background FROM volume_ingestion_state WHERE protocol = ?")
      .bind(protocol).first<{ day: number; pages: number; background: number }>();
    const stored = await d1.prepare("SELECT COALESCE(SUM(staged_rows), 0) AS count FROM volume_feed_hours WHERE protocol = ?")
      .bind(protocol).first<{ count: number }>();
    const backgroundAvailable = (!usage || usage.day !== day || (usage.pages < pageBudget.limit && usage.background < pageBudget.backgroundLimit))
      && (stored?.count ?? 0) + 250 <= maxStagedSwapsPerProvider - liveStagingReserve;
    const horizonDays = Math.max(...volumePeriods(environment));
    job = await d1.prepare(`SELECT id, hour, status, generation, cursor, pages, records, failures FROM volume_feed_hours
      WHERE protocol = ? AND hour >= ? AND hour < ? AND next_attempt <= ?
        AND failures < 6 AND (status != 'complete' OR ((pending > 0 OR generation < 4) AND hour >= ?))
        AND (hour >= ? OR ? = 1)
      ORDER BY CASE WHEN hour >= ? AND status != 'complete' THEN 0 WHEN hour >= ? THEN 1
        WHEN status = 'running' THEN 2 WHEN status != 'complete' THEN 3 ELSE 4 END, hour DESC LIMIT 1`)
      .bind(protocol, cutoff - horizonDays * 24 * hourMs, cutoff, now, cutoff - 7 * 24 * hourMs,
        cutoff - 24 * hourMs, backgroundAvailable ? 1 : 0, cutoff - 24 * hourMs, cutoff - 24 * hourMs).first<FeedHour>();
    if (!job) return;
    const live = job.hour >= cutoff - 24 * hourMs;
    if (job.status !== "running") {
      job.generation++; job.cursor = null; job.pages = 0; job.records = 0;
      await d1.batch([
        d1.prepare("DELETE FROM volume_recent_swaps WHERE job_id = ? AND EXISTS (SELECT 1 FROM volume_ingestion_state WHERE protocol = ? AND lease = ?)").bind(job.id, protocol, lease),
        d1.prepare("UPDATE volume_feed_hours SET status = 'running', generation = ?, cursor = NULL, pages = 0, records = 0, pending = 0, staged_rows = 0, updated_at = ? WHERE id = ? AND EXISTS (SELECT 1 FROM volume_ingestion_state WHERE protocol = ? AND lease = ?)").bind(job.generation, new Date().toISOString(), job.id, protocol, lease),
      ]);
      await assertLease(d1, protocol, lease);
    }
    const keys = await volumeRouteKeys(d1);
    // NEAR's global partner rate limit applies to backfills as well as live jobs.
    const pageLimit = protocol === "near-intents" ? 1 : 6;
    for (let page = 0; page < pageLimit && Date.now() - now < 18_000; page++) {
      if (job.pages >= maxPagesPerHour) throw new FeedError("Hourly history exceeded the configured page budget", 3600);
      const staged = await d1.prepare("SELECT COALESCE(SUM(staged_rows), 0) AS count FROM volume_feed_hours WHERE protocol = ?")
        .bind(protocol).first<{ count: number }>();
      const storageLimit = live ? maxStagedSwapsPerProvider : maxStagedSwapsPerProvider - liveStagingReserve;
      if ((staged?.count ?? 0) + 250 > storageLimit) throw new FeedError(live ? "Provider staging storage budget reached; waiting for retention cleanup" : "Background staging budget reached; live storage remains reserved", 1800);
      const budgetDay = Math.floor(Date.now() / (24 * hourMs));
      const limits = volumePageBudget(environment);
      const budget = await d1.prepare(`UPDATE volume_ingestion_state SET budget_day = ?,
        pages_today = CASE WHEN budget_day = ? THEN pages_today + 1 ELSE 1 END,
        background_pages_today = CASE WHEN budget_day = ? THEN background_pages_today + ? ELSE ? END
        WHERE protocol = ? AND lease = ? AND (budget_day != ? OR pages_today < ?)
          AND (? = 1 OR budget_day != ? OR background_pages_today < ?)`)
        .bind(budgetDay, budgetDay, budgetDay, live ? 0 : 1, live ? 0 : 1, protocol, lease,
          budgetDay, live ? limits.liveTotalLimit : limits.limit, live ? 1 : 0, budgetDay, limits.backgroundLimit).run();
      if (!budget.meta.changes) {
        await assertLease(d1, protocol, lease);
        throw new FeedError(live ? "Daily history request budget reached; collection resumes tomorrow" : "Background history budget reached; live pages remain reserved",
          Math.max(60, Math.ceil(((budgetDay + 1) * 24 * hourMs - Date.now()) / 1000)));
      }
      const data = await fetchVolumePage(protocol, job.hour, job.hour + hourMs, job.cursor, environment);
      const guard = "EXISTS (SELECT 1 FROM volume_ingestion_state WHERE protocol = ? AND lease = ?)";
      const size = await d1.prepare("SELECT COUNT(*) AS count FROM volume_recent_swaps WHERE job_id = ? AND generation = ?")
        .bind(job.id, job.generation).first<{ count: number }>();
      if ((size?.count ?? 0) + data.events.length > maxTrackedSwapsPerHour) throw new FeedError("Tracked hourly swaps exceeded the configured storage budget", 3600);
      const statements = data.events.filter((event) => keys.has(event.routeId)).map((event) => d1.prepare(`
        INSERT INTO volume_recent_swaps (id, job_id, generation, route_key, usd_micros, pending, created_at)
        SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${guard}
        ON CONFLICT(id) DO UPDATE SET usd_micros = excluded.usd_micros, pending = excluded.pending
        WHERE volume_recent_swaps.usd_micros IS NOT excluded.usd_micros OR volume_recent_swaps.pending != excluded.pending
      `).bind(`${job!.id}:${job!.generation}:${event.id}`, job!.id, job!.generation, keys.get(event.routeId), event.usdMicros,
        event.pending ? 1 : 0, Date.now(), protocol, lease));
      job.pages++; job.records += data.records; job.cursor = data.cursor;
      statements.push(d1.prepare(`UPDATE volume_feed_hours SET pages = ?, records = ?, cursor = ?, pending = pending + ?, updated_at = ?
        , staged_rows = (SELECT COUNT(*) FROM volume_recent_swaps WHERE job_id = ? AND generation = ?)
        WHERE id = ? AND generation = ? AND ${guard}`).bind(job.pages, job.records, job.cursor, data.pending, new Date().toISOString(), job.id, job.generation, job.id, job.generation, protocol, lease));
      statements.push(d1.prepare("UPDATE volume_ingestion_state SET next_request = ?, updated_at = ?, last_error = NULL WHERE protocol = ? AND lease = ?")
        .bind(Date.now() + (protocol === "near-intents" ? 5_100 : 0), new Date().toISOString(), protocol, lease));
      await d1.batch(statements);
      await assertLease(d1, protocol, lease);
      if (!job.cursor) { await finalizeHour(job, protocol, lease, environment); break; }
      continuation = true;
    }
    // Continue through bounded backfill tasks; fresh hours have higher priority.
    continuation = true;
  } catch (error) {
    if (error instanceof LostLease) return;
    const failure = error instanceof FeedError ? error : new FeedError("Volume history collection failed; retry scheduled");
    const backgroundPause = failure.message.startsWith("Background ");
    delay = Math.max(failure.retrySeconds, Math.min(3600, 30 * 2 ** Math.min(job?.failures ?? 0, 6)));
    await d1.prepare("UPDATE volume_ingestion_state SET last_error = ?, next_request = ?, updated_at = ? WHERE protocol = ? AND lease = ?")
      .bind(backgroundPause ? null : failure.message, Date.now() + (backgroundPause ? protocol === "near-intents" ? 5_100 : 0 : delay * 1000), new Date().toISOString(), protocol, lease).run();
    const budgetPause = backgroundPause || failure.message.startsWith("Daily history") || failure.message.startsWith("Provider staging");
    if (job) await d1.prepare(`UPDATE volume_feed_hours SET failures = failures + ?, last_error = ?, next_attempt = ?, updated_at = ?
      WHERE id = ? AND EXISTS (SELECT 1 FROM volume_ingestion_state WHERE protocol = ? AND lease = ?)`)
      .bind(budgetPause ? 0 : 1, failure.message, Date.now() + delay * 1000, new Date().toISOString(), job.id, protocol, lease).run();
    if (backgroundPause) delay = protocol === "near-intents" ? 6 : 5;
    continuation = backgroundPause || (!failure.unauthorized && !budgetPause && (job?.failures ?? 0) < 5);
  } finally {
    await d1.prepare("UPDATE volume_ingestion_state SET lease = NULL, lease_until = 0 WHERE protocol = ? AND lease = ?").bind(protocol, lease).run();
  }
  if (continuation && environment.VOLUME_QUEUE) await environment.VOLUME_QUEUE.send({ kind: "volume-collect", protocol }, { delaySeconds: delay });
}

export async function pruneVolume(time: number, environment: VolumeEnvironment) {
  if (environment.VOLUME_COLLECTION_ENABLED !== "true") return;
  const d1 = environment.DB;
  const cutoff = time - volumeRetentionDays * 24 * hourMs;
  // Never resume from an old page cursor after its deduplication input expires.
  await d1.prepare(`UPDATE volume_feed_hours SET status = 'pending', cursor = NULL, pages = 0, failures = 6,
    last_error = 'Incomplete scan expired; reset this hour to rebuild it from the start'
    WHERE status != 'complete' AND id IN (SELECT job_id FROM volume_recent_swaps WHERE created_at < ?)`)
    .bind(time - 7 * 24 * hourMs).run();
  for (const table of ["volume_hourly", "route_quote_hourly"]) {
    for (let batch = 0; batch < 12; batch++) {
      const result = await d1.prepare(`DELETE FROM ${table} WHERE id IN (SELECT id FROM ${table} WHERE hour < ? LIMIT 1000)`).bind(cutoff).run();
      if (result.meta.changes < 1000) break;
    }
  }
  for (let batch = 0; batch < 400; batch++) {
    const result = await d1.prepare(`DELETE FROM volume_recent_swaps WHERE id IN (
      SELECT s.id FROM volume_recent_swaps s LEFT JOIN volume_feed_hours h ON h.id = s.job_id
      WHERE s.created_at < ? AND (h.status = 'complete' OR s.created_at < ? OR h.hour < ? OR h.id IS NULL) LIMIT 1000
    )`).bind(time - 72 * hourMs, time - 7 * 24 * hourMs, cutoff).run();
    if (result.meta.changes < 1000) break;
  }
  await d1.prepare(`UPDATE volume_feed_hours SET staged_rows = 0 WHERE staged_rows > 0
    AND id NOT IN (SELECT DISTINCT job_id FROM volume_recent_swaps)`).run();
  // Retain accounting for any input the bounded cleanup did not finish yet.
  for (let batch = 0; batch < 12; batch++) {
    const result = await d1.prepare(`DELETE FROM volume_feed_hours WHERE id IN (
      SELECT h.id FROM volume_feed_hours h WHERE hour < ? AND NOT EXISTS (
        SELECT 1 FROM volume_recent_swaps s WHERE s.job_id = h.id) LIMIT 1000
    )`).bind(cutoff).run();
    if (result.meta.changes < 1000) break;
  }
}
