import { quoteSizes } from "../lib/quotes/sizes";

export type PartnerId = "thorchain" | "chainflip" | "near-intents" | "maya";
export type ViewWindow = "now" | "7d" | "14d" | "30d";
export type TrendDays = 1 | 7 | 14 | 30;
export type DashboardQuery = Record<string, string | string[] | undefined>;

export type NormalizedDashboardQuery = {
  assets: string[];
  protocols: PartnerId[];
  window: ViewWindow;
  sizeId: string;
  days: TrendDays;
  volumeDays: 1 | 7 | 30;
  runId: number | null;
  sourceId: string;
  back: string;
};

export const defaultProtocols: PartnerId[] = ["thorchain", "maya", "chainflip", "near-intents"];

function singleQueryValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export function normalizeDashboardQuery(query: DashboardQuery): NormalizedDashboardQuery {
  const protocolIds = (singleQueryValue(query.protocols) ?? "").split(",").filter((id): id is PartnerId => defaultProtocols.includes(id as PartnerId));
  const window = singleQueryValue(query.window);
  const days = Number(singleQueryValue(query.days));
  const volumeDays = Number(singleQueryValue(query.volumeDays));
  const sizeId = singleQueryValue(query.size);
  const back = singleQueryValue(query.back);
  const runId = Number(singleQueryValue(query.runId));
  return {
    assets: (singleQueryValue(query.assets) ?? "").split(",").filter(Boolean),
    protocols: protocolIds.length >= 2 ? protocolIds : defaultProtocols,
    window: window === "7d" || window === "14d" || window === "30d" ? window : "now",
    sizeId: quoteSizes.some((size) => size.id === sizeId) ? sizeId! : quoteSizes[3].id,
    days: days === 7 || days === 14 || days === 30 ? days : 1,
    volumeDays: volumeDays === 7 || volumeDays === 30 ? volumeDays : 1,
    runId: Number.isSafeInteger(runId) && runId > 0 ? runId : null,
    sourceId: singleQueryValue(query.source) ?? "",
    back: back?.startsWith("/") && !back.startsWith("//") ? back : "/#leaderboard-results",
  };
}
