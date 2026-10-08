import type { PartnerId } from "../routes/catalog";

export const volumeProtocols: PartnerId[] = ["thorchain", "maya", "chainflip", "near-intents"];
export const hourMs = 3_600_000;
export const volumeRetentionDays = 35;
export type VolumeDays = 1 | 7 | 30;
export type VolumeBudgetConfig = {
  VOLUME_DAILY_PAGE_LIMIT?: string; VOLUME_LIVE_PAGE_RESERVE?: string;
  VOLUME_LIVE_CATCHUP_DAY?: string; VOLUME_LIVE_CATCHUP_PAGES?: string;
};
export function volumePageBudget(config: VolumeBudgetConfig, time = Date.now()) {
  const limit = Math.max(100, Math.min(10_000, Math.floor(Number(config.VOLUME_DAILY_PAGE_LIMIT) || 2000)));
  const configured = Number(config.VOLUME_LIVE_PAGE_RESERVE);
  const liveReserve = Math.max(0, Math.min(limit, Number.isFinite(configured) ? Math.floor(configured) : Math.floor(limit / 2)));
  const catchup = config.VOLUME_LIVE_CATCHUP_DAY === new Date(time).toISOString().slice(0, 10)
    ? Math.max(0, Math.min(500, Math.floor(Number(config.VOLUME_LIVE_CATCHUP_PAGES) || 0))) : 0;
  return { limit, liveReserve, backgroundLimit: limit - liveReserve, liveTotalLimit: limit + catchup, catchup };
}
export function volumePeriods(config: { VOLUME_30D_ENABLED?: string }): VolumeDays[] {
  return config.VOLUME_30D_ENABLED === "true" ? [1, 7, 30] : [1, 7];
}
export const volumeBuckets = [
  { id: "500", label: "≤$500", upper: 500 },
  { id: "1000", label: "$500–$1K", upper: 1_000 },
  { id: "10000", label: "$1K–$10K", upper: 10_000 },
  { id: "50000", label: "$10K–$50K", upper: 50_000 },
  { id: "100000", label: "$50K–$100K", upper: 100_000 },
  { id: "500000", label: "$100K–$500K", upper: 500_000 },
  { id: "1000000", label: "$500K–$1M", upper: 1_000_000 },
  { id: "overflow", label: ">$1M", upper: null },
] as const;

export type VolumeTotals = { usdMicros: string[]; swaps: number[]; unpriced: number };
export type VolumeEvent = { id: string; routeId: string; timestamp: number; usdMicros: string | null; pending: boolean };
export type FeedPage = { events: VolumeEvent[]; cursor: string | null; pending: number; records: number };
export type QuoteScore = { wins: number; samples: number; successes: number; competing: number };
export type QuoteHour = Record<string, Partial<Record<PartnerId, QuoteScore>>>;
export type VolumeCoverage = {
  protocol: PartnerId; scope: string; hours: number; expectedHours: number;
  status: "complete" | "partial" | "unavailable" | "not-applicable"; updatedAt: string | null; error: string | null;
};
export type RouteVolumeResponse = {
  schemaVersion: 2; routeId: string; days: VolumeDays; startAt: string | null; endAt: string | null; updatedAt: string | null;
  requestedStartAt: string; requestedEndAt: string;
  comparison: { protocols: PartnerId[]; hours: number; expectedHours: number };
  status: "complete" | "partial" | "unavailable"; timing: "provider-recorded";
  coverage: VolumeCoverage[]; volumeUsd: number; swapCount: number; unpricedSwaps: number;
  buckets: Array<{ id: string; label: string; volumeUsd: number; swapCount: number;
    providers: Array<{ protocol: PartnerId; volumeUsd: number; swapCount: number; available: boolean }>;
    leaders: PartnerId[]; winRate: number | null; samples: number; competingSamples: number;
  }>;
};

// Exact fixed-point parsing avoids Number rounding at bucket boundaries.
export function decimalUnits(value: unknown, decimals = 6): bigint | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value);
  if (text.length > 100) return null;
  const match = /^(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match) return null;
  const shift = decimals + Number(match[3] ?? 0) - (match[2]?.length ?? 0);
  if (!Number.isInteger(shift) || Math.abs(shift) > 60) return null;
  const digits = BigInt(match[1] + (match[2] ?? ""));
  if (shift >= 0) return digits * 10n ** BigInt(shift);
  const divisor = 10n ** BigInt(-shift);
  return (digits + divisor / 2n) / divisor;
}

export function bucketIndex(micros: bigint) {
  if (micros <= 0n) return -1;
  return volumeBuckets.findIndex((bucket) => bucket.upper === null || micros <= BigInt(bucket.upper) * 1_000_000n);
}

export function emptyTotals(): VolumeTotals {
  return { usdMicros: volumeBuckets.map(() => "0"), swaps: volumeBuckets.map(() => 0), unpriced: 0 };
}

export function addEvent(totals: VolumeTotals, event: Pick<VolumeEvent, "usdMicros" | "pending">) {
  if (event.pending) return;
  const value = event.usdMicros === null ? null : BigInt(event.usdMicros);
  if (value === null || value <= 0n) { totals.unpriced++; return; }
  const index = bucketIndex(value);
  totals.usdMicros[index] = (BigInt(totals.usdMicros[index]) + value).toString();
  totals.swaps[index]++;
}

export function mergeTotals(target: VolumeTotals, source: VolumeTotals) {
  for (let index = 0; index < volumeBuckets.length; index++) {
    target.usdMicros[index] = (BigInt(target.usdMicros[index]) + BigInt(source.usdMicros[index])).toString();
    target.swaps[index] += source.swaps[index];
  }
  target.unpriced += source.unpriced;
}

export function scoreQuotes(quotes: Array<{ protocol: PartnerId; output: number }>): Partial<Record<PartnerId, QuoteScore>> {
  const valid = quotes.filter((quote) => Number.isFinite(quote.output) && quote.output > 0);
  const best = Math.max(...valid.map((quote) => quote.output));
  const winners = valid.filter((quote) => quote.output === best).length;
  return Object.fromEntries(volumeProtocols.map((protocol) => {
    const quote = valid.find((item) => item.protocol === protocol);
    return [protocol, { wins: quote?.output === best ? 1 / winners : 0,
      samples: valid.length ? 1 : 0, successes: quote ? 1 : 0, competing: valid.length >= 2 ? 1 : 0 }];
  }));
}

export const volumeScopes: Record<PartnerId, string> = {
  thorchain: "External L1 swaps · Midgard", maya: "External L1 swaps · Midgard",
  chainflip: "Regular customer swap requests · Explorer", "near-intents": "1Click swaps · Explorer",
};
