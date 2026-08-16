export type UsdRange = {
  id: string;
  min: number;
  max: number;
  includeMax?: boolean;
};

export const usdRanges: UsdRange[] = [
  { id: "1-100", min: 1, max: 100 },
  { id: "100-1000", min: 100, max: 1_000 },
  { id: "1000-10000", min: 1_000, max: 10_000 },
  { id: "10000-50000", min: 10_000, max: 50_000 },
  { id: "50000-100000", min: 50_000, max: 100_000 },
  { id: "100000-200000", min: 100_000, max: 200_000 },
  { id: "200000-500000", min: 200_000, max: 500_000 },
  { id: "500000-1000000", min: 500_000, max: 1_000_000, includeMax: true },
];

export function initialSamplesForRange(range: UsdRange): [number, number, number] {
  const high = range.includeMax ? range.max : range.max - Math.max(0.01, range.max * 0.000001);
  const midpoint = Math.sqrt(range.min * high);
  return [range.min, midpoint, high];
}

export function rangeNeedsCrossoverSampling(winners: string[]) {
  return new Set(winners).size > 1;
}
