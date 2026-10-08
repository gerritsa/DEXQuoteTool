import { emptyTotals, mergeTotals, volumeBuckets, volumeProtocols, volumeScopes, hourMs,
  type QuoteHour, type QuoteScore, type RouteVolumeResponse, type VolumeDays, type VolumeTotals } from "./model";
import type { PartnerId } from "../routes/catalog";

export type HourTotal = { protocol: PartnerId; hour: number; totalsJson: string; updatedAt: string };
export type HourCoverage = { protocol: PartnerId; hour: number; status: string; updatedAt: string | null };
export type HourQuotes = { hour: number; scoresJson: string };

export function buildVolumeWindow(routeId: string, days: VolumeDays, end: number, totals: HourTotal[], hours: HourCoverage[],
  quotes: HourQuotes[], errors: Partial<Record<PartnerId, string | null>> = {}, supported: PartnerId[] = volumeProtocols): RouteVolumeResponse {
  const start = end - days * 24 * hourMs;
  const selectedHours = hours.filter((row) => row.hour >= start && row.hour < end && row.status === "complete");
  const complete = new Set(selectedHours.map((row) => `${row.protocol}:${row.hour}`));
  const parsedTotals = totals.filter((row) => row.hour >= start && row.hour < end)
    .map((row) => ({ ...row, totals: JSON.parse(row.totalsJson) as VolumeTotals }));
  const parsedQuotes = quotes.filter((row) => row.hour >= start && row.hour < end)
    .map((row) => ({ ...row, scores: JSON.parse(row.scoresJson) as QuoteHour }));
  const required = new Set(supported);
  for (const row of parsedTotals) if (row.totals.unpriced || row.totals.swaps.some((count) => count > 0)) required.add(row.protocol);
  for (const row of parsedQuotes) for (const scores of Object.values(row.scores)) {
    for (const protocol of volumeProtocols) if ((scores[protocol]?.successes ?? 0) > 0) required.add(protocol);
  }
  if (!required.size) for (const protocol of volumeProtocols) required.add(protocol);
  const shared = (hour: number) => [...required].every((protocol) => complete.has(`${protocol}:${hour}`));
  let sharedEnd: number | null = null;
  for (let hour = end - hourMs; hour >= start; hour -= hourMs) {
    if (shared(hour)) { sharedEnd = hour + hourMs; break; }
  }
  let sharedStart = sharedEnd;
  if (sharedEnd !== null) for (let hour = sharedEnd - hourMs; hour >= start && shared(hour); hour -= hourMs) sharedStart = hour;
  const sharedHours = sharedStart === null || sharedEnd === null ? 0 : (sharedEnd - sharedStart) / hourMs;
  const inSharedWindow = (hour: number) => sharedStart !== null && sharedEnd !== null && hour >= sharedStart && hour < sharedEnd;
  const byProtocol = new Map(volumeProtocols.map((protocol) => [protocol, emptyTotals()]));
  let updatedAt: string | null = null;
  for (const row of parsedTotals) {
    if (!required.has(row.protocol) || !inSharedWindow(row.hour)) continue;
    mergeTotals(byProtocol.get(row.protocol)!, row.totals);
    if (!updatedAt || row.updatedAt > updatedAt) updatedAt = row.updatedAt;
  }
  const coverage = volumeProtocols.map((protocol) => {
    const records = selectedHours.filter((row) => row.protocol === protocol && inSharedWindow(row.hour));
    const newest = records.map((row) => row.updatedAt).filter((value): value is string => !!value).sort().at(-1) ?? null;
    const count = required.has(protocol) ? sharedHours : 0;
    return { protocol, scope: volumeScopes[protocol], hours: count, expectedHours: days * 24,
      status: !required.has(protocol) ? "not-applicable" as const : sharedStart === start && sharedEnd === end ? "complete" as const : count ? "partial" as const : "unavailable" as const,
      updatedAt: newest, error: errors[protocol] ?? null };
  });
  const scores: QuoteHour = {};
  for (const row of parsedQuotes.filter((row) => inSharedWindow(row.hour))) {
    for (const [size, results] of Object.entries(row.scores)) {
      const target = scores[size] ??= {};
      for (const protocol of volumeProtocols) {
        const source = results[protocol];
        if (!source) continue;
        const score = target[protocol] ??= { wins: 0, samples: 0, successes: 0, competing: 0 };
        for (const key of ["wins", "samples", "successes", "competing"] as const) score[key] += source[key];
      }
    }
  }
  const buckets = volumeBuckets.map((bucket, index) => {
    const providers = volumeProtocols.map((protocol) => ({ protocol,
      volumeUsd: Number(BigInt(byProtocol.get(protocol)!.usdMicros[index])) / 1_000_000,
      swapCount: byProtocol.get(protocol)!.swaps[index], available: coverage.find((item) => item.protocol === protocol)!.hours > 0,
    }));
    const result = scores[bucket.id] ?? {};
    const entries = Object.entries(result) as Array<[PartnerId, QuoteScore]>;
    const highest = Math.max(0, ...entries.map(([, score]) => score.wins));
    const samples = Math.max(0, ...entries.map(([, score]) => score.samples));
    return { id: bucket.id, label: bucket.label, providers,
      volumeUsd: providers.reduce((sum, item) => sum + item.volumeUsd, 0),
      swapCount: providers.reduce((sum, item) => sum + item.swapCount, 0),
      leaders: highest > 0 ? entries.filter(([, score]) => Math.abs(score.wins - highest) < 1e-9).map(([protocol]) => protocol) : [],
      winRate: samples ? highest / samples : null, samples,
      competingSamples: Math.max(0, ...entries.map(([, score]) => score.competing)),
    };
  });
  return { schemaVersion: 2, routeId, days, startAt: sharedStart === null ? null : new Date(sharedStart).toISOString(),
    endAt: sharedEnd === null ? null : new Date(sharedEnd).toISOString(), updatedAt,
    requestedStartAt: new Date(start).toISOString(), requestedEndAt: new Date(end).toISOString(),
    comparison: { protocols: volumeProtocols.filter((protocol) => required.has(protocol)), hours: sharedHours, expectedHours: days * 24 },
    status: sharedStart === start && sharedEnd === end ? "complete" : sharedHours ? "partial" : "unavailable",
    timing: "provider-recorded", coverage, buckets,
    volumeUsd: buckets.reduce((sum, bucket) => sum + bucket.volumeUsd, 0),
    swapCount: buckets.reduce((sum, bucket) => sum + bucket.swapCount, 0),
    unpricedSwaps: Array.from(byProtocol.values()).reduce((sum, total) => sum + total.unpriced, 0),
  };
}
