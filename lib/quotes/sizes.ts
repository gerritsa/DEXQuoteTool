export type QuoteSize = {
  id: string;
  amountUsd: number;
  label: string;
};

export const quoteSizes: QuoteSize[] = [
  { id: "500", amountUsd: 500, label: "$500" },
  { id: "1000", amountUsd: 1_000, label: "$1K" },
  { id: "10000", amountUsd: 10_000, label: "$10K" },
  { id: "50000", amountUsd: 50_000, label: "$50K" },
  { id: "100000", amountUsd: 100_000, label: "$100K" },
  { id: "500000", amountUsd: 500_000, label: "$500K" },
  { id: "1000000", amountUsd: 1_000_000, label: "$1M" },
];
