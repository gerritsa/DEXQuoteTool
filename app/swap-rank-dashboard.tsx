"use client";
/* eslint-disable @next/next/no-img-element -- small static logos are served directly by the Worker */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { defaultProtocols, type ExecutionMode, type NormalizedDashboardQuery, type PartnerId, type TrendDays, type ViewWindow } from "./dashboard-query";
import { quoteSizes, type QuoteSize } from "../lib/quotes/sizes";
import { rawArchiveRetentionDays } from "../lib/quotes/retention";

type Theme = "dark" | "light";
type DashboardView = "leaderboard" | "analysis";
type AnalysisPanel = "performance" | "depth";

const pageRefreshIntervalMs = 15 * 60_000;
const resumeRefreshThresholdMs = 60_000;
const manualRefreshCooldownMs = 60_000;

type Route = {
  id: string;
  source: { id: string; label: string; chain: string; symbol: string; thorAsset: string; decimals: number };
  destination: { id: string; label: string; chain: string; symbol: string; thorAsset: string; decimals: number };
  partners: PartnerId[];
};

type CatalogResponse = {
  routes: Route[];
  catalog?: {
    status: "fresh" | "stale";
    source: "live" | "stored" | "static";
    refreshedAt: string | null;
    warning?: string;
  };
  error?: string;
};

type ComparisonCell = {
  pairId: string;
  amountId: string;
  capturedAt?: string;
  leader: PartnerId | null;
  runnerUp?: PartnerId | null;
  marginBps?: number | null;
  tie?: boolean;
  successfulQuotes?: number;
  winRate?: number | null;
  sampleCount?: number;
  availability?: number | null;
  oracleGapBps?: number | null;
  averageOracleGapBps?: number | null;
};

type TrendPoint = {
  protocol: PartnerId;
  oracleGapBps: number | null;
  sampleCount: number;
  winRate: number | null;
};

type TrendResponse = {
  days: number;
  bucketMs: number;
  pointMode: "comparison" | "bucket_median";
  startAt: string;
  endAt: string;
  comparableRuns: number;
  leader: null | { protocol: PartnerId; averageOracleGapBps: number; medianOracleGapBps: number; winRate: number; sampleCount: number; availability: number };
  summary: Array<{ protocol: PartnerId; averageOracleGapBps: number | null; medianOracleGapBps: number | null; winRate: number | null; sampleCount: number; availability: number }>;
  buckets: Array<{ timestamp: number; points: TrendPoint[] }>;
  error?: string;
};

type ComparisonResponse = {
  window: ViewWindow;
  cells: ComparisonCell[];
  error?: string;
};

type HealthResponse = {
  status: "healthy" | "degraded" | "stale" | "initializing" | "unhealthy";
  checkedAt: string;
  schedule?: string;
  latestSweep: null | {
    id: string;
    scheduledFor: string;
    status: string;
    routeCount: number;
    jobCount: number;
    completedJobs: number;
    failedJobs: number;
    completedAt: string | null;
    missingRoutes: string[];
  };
  minutesSinceTerminalSweep: number | null;
  partners?: Array<{ protocol: string; attempts: number; successes: number; unavailable: number; errors: number; latestResponseAt: string | null }>;
  catalog?: null | {
    status: "fresh" | "stored" | "paused";
    refreshedAt: string | null;
    lastAttemptAt: string;
    ageMinutes: number | null;
    collectionPaused: boolean;
    error: string | null;
  };
  warnings?: string[];
  error?: string;
};

type RunResponse = {
  rawDetailsAvailable?: boolean;
  navigation?: {
    previous: { runId: number; initiatedAt: string } | null;
    next: { runId: number; initiatedAt: string } | null;
  };
  depthForecast?: null | {
    modelVersion: "thor-depth-v1" | "thor-depth-v2" | "thor-depth-v3" | "thor-depth-v4";
    status: "available" | "unavailable";
    reason?: string;
    capturedAt: string;
    competitiveWithinBps: number;
    bestProtocol?: PartnerId;
    bestOutput?: number;
    currentThorOutput?: number;
    currentGapBps?: number;
    sourceAmountFormatted?: number;
    poolImpliedRate?: number;
    oracleRate?: number | null;
    bestQuoteRate?: number;
    poolRateGapVsOracleBps?: number | null;
    currentOracleGapBps?: number | null;
    executionDragVsOracleBps?: number | null;
    executionCostVsOracleBps?: number | null;
    reportedSlippageVsOracleBps?: number | null;
    liquidityFeeVsOracleBps?: number | null;
    outboundFeeVsOracleBps?: number | null;
    unexplainedExecutionCostVsOracleBps?: number | null;
    poolRateGapVsBestBps?: number;
    executionDragBps?: number;
    executionCostBps?: number;
    reportedSlippageBps?: number | null;
    liquidityFeeBps?: number | null;
    unexplainedExecutionCostBps?: number | null;
    asymptoticGapBps?: number | null;
    depthRecoverableBps?: number | null;
    outboundFeeBps?: number;
    effectiveDepthMultiplier?: number;
    estimateConfidence?: "low";
    estimateConfidenceReason?: string;
    streamingChunks?: number;
    requiredDepthMultiplier?: number | null;
    requiredAdditionalLiquidityUsd?: number | null;
    depthAloneSufficient?: boolean;
    priceRebalanceBps?: number | null;
    bindingPool?: "source" | "destination" | "balanced" | null;
    sourcePool?: DepthForecastPool;
    destinationPool?: DepthForecastPool;
    curve?: Array<{ multiplier: number; gapBps: number }>;
  };
  run: null | {
    id: number;
    initiatedAt: string;
    sourceAmountBaseUnits: string;
    sourceAmountUsd: number;
    sourcePriceUsd: number;
    mode: string;
    status: string;
    maxRequestSkewMs?: number | null;
    oracleSourcePriceUsd?: number | null;
    oracleDestinationPriceUsd?: number | null;
    oracleReferenceOutput?: number | null;
    oracleCapturedAt?: string | null;
  };
  quotes: Array<{
    id: number;
    protocol: PartnerId;
    strategy: string;
    status: string;
    errorCode?: string | null;
    expectedOutputFormatted?: string | null;
    expectedOutputBaseUnits?: string | null;
    oracleGapBps?: number | null;
    requestStartedAt: string;
    responseLatencyMs?: number | null;
    responseHttpStatus?: number | null;
    quoteExpiresAt?: string | null;
    requestUrl?: string | null;
    requestPayloadJson?: string | null;
    rawResponseJson?: string | null;
    errorMessage?: string | null;
  }>;
  error?: string;
};

type DepthForecastPool = {
  asset: string;
  assetDepth: string;
  runeDepth: string;
  liquidityUsd: number;
  role: "source" | "destination";
  requiredMultiplierIfScaledAlone: number | null;
  requiredAdditionalLiquidityUsd: number | null;
};

const partners: Array<{ id: PartnerId; name: string; cellName: string; color: string; logo: string; disabled?: boolean }> = [
  { id: "thorchain", name: "THORCHAIN", cellName: "THORCHAIN", color: "#17b897", logo: "/partners/thorchain.png" },
  { id: "maya", name: "MAYA PROTOCOL", cellName: "MAYA PROTOCOL", color: "#ef6a38", logo: "/partners/maya.svg", disabled: true },
  { id: "chainflip", name: "CHAINFLIP", cellName: "CHAINFLIP", color: "#ed49c9", logo: "/partners/chainflip.svg" },
  { id: "near-intents", name: "NEAR", cellName: "NEAR", color: "var(--near-series)", logo: "/partners/near.svg" },
];

function chainLabel(chain: string) {
  return chain.replace(/(^|[-_ ])\w/g, (value) => value.toUpperCase());
}

function compactChainLabel(chain: string) {
  if (chain === "ethereum") return "ETH";
  if (chain === "bitcoin") return "BTC";
  return chain.toUpperCase();
}

function routeMatchesAssets(route: Route, selected: ReadonlySet<string>) {
  return selected.size === 0 || selected.has(route.source.id) || selected.has(route.destination.id);
}

function routeMatchesProtocols(route: Route, selected: ReadonlySet<PartnerId>) {
  return route.partners.filter((partner) => selected.has(partner)).length >= 2;
}

function PartnerMark({ id, muted = false }: { id: PartnerId; muted?: boolean }) {
  const partner = partners.find((item) => item.id === id)!;
  return <span className={`partner-mark logo-${id} ${muted ? "muted" : ""}`} role="img" aria-label={partner.name} title={partner.name}><img src={partner.logo} alt="" /></span>;
}

function executionLabel(mode: ExecutionMode) {
  return mode === "standard" ? "Standard swap" : "Streaming/DCA";
}

function AssetMark({ asset }: { asset: Route["source"] }) {
  const symbol = asset.symbol.toLowerCase();
  const extension = ["bch", "bnb", "doge", "ltc", "sol", "xrp"].includes(symbol) ? "svg" : "png";
  return <span className="asset-mark" role="img" aria-label={`${asset.symbol} asset`}><img src={`/assets/${symbol}.${extension}`} alt="" /></span>;
}

function RoutePair({ route }: { route: Route }) {
  return <span className="route-pair"><span className="route-asset"><AssetMark asset={route.source} /><span><b>{route.source.symbol}</b><small>{route.source.chain}</small></span></span><i aria-hidden="true">→</i><span className="route-asset"><AssetMark asset={route.destination} /><span><b>{route.destination.symbol}</b><small>{route.destination.chain}</small></span></span></span>;
}

function compactThorAsset(asset: Route["source"]) {
  return asset.thorAsset.split("-")[0];
}

function LeaderboardRoutePath({ route }: { route: Route }) {
  const fullPath = `${route.source.thorAsset} → ${route.destination.thorAsset}`;
  return <span className="leaderboard-route-path" title={fullPath}>
    <code>{compactThorAsset(route.source)} <i aria-hidden="true">→</i> {compactThorAsset(route.destination)}</code>
    <span className="leaderboard-asset-logos" aria-hidden="true"><AssetMark asset={route.source} /><AssetMark asset={route.destination} /></span>
  </span>;
}

function formatTime(value?: string) {
  if (!value) return "—";
  return new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatLocalTime(value?: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function formatAge(value: string | undefined | null, now = Date.now()) {
  if (!value) return "—";
  const delta = now - new Date(value).getTime();
  if (delta < 0) return "queued";
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d`;
}

function formatAgeLabel(value: string | undefined | null, now = Date.now()) {
  const age = formatAge(value, now);
  if (age === "—" || age === "queued") return age;
  if (age === "just now") return "0 min ago";
  if (/^\d+m$/.test(age)) return `${age.slice(0, -1)} min ago`;
  return `${age} ago`;
}

function formatBps(value?: number | null) {
  if (value == null || !Number.isFinite(value)) return "—";
  const precision = Math.abs(value) < 10 ? 1 : 0;
  return `${value > 0 ? "+" : ""}${value.toFixed(precision)} bps`;
}

function trendPeriodLabel(days: TrendDays) {
  return days === 1 ? "the last 24 hours" : `${days} days`;
}

function trendPointContext(point: TrendPoint, pointMode: TrendResponse["pointMode"]) {
  if (pointMode === "comparison") return point.winRate ? "batch winner · synchronized comparison" : "synchronized comparison";
  return `${Math.round((point.winRate ?? 0) * 100)}% wins · ${point.sampleCount} samples in bucket`;
}

function formatTokenAmount(value?: string | number | null) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "—";
  const absolute = Math.abs(amount);
  const maximumFractionDigits = absolute >= 1_000 ? 2 : absolute >= 1 ? 4 : absolute >= 0.01 ? 6 : 8;
  return amount.toLocaleString([], { maximumFractionDigits });
}

function formatCompactUsd(value?: number | null) {
  if (value == null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat([], { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function formatExchangeRate(value?: number | null) {
  if (value == null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat([], { maximumSignificantDigits: 8 }).format(value);
}

function formatBaseUnits(value: string, decimals: number) {
  const negative = value.startsWith("-");
  const digits = (negative ? value.slice(1) : value).padStart(decimals + 1, "0");
  const integer = digits.slice(0, -decimals || undefined);
  const fraction = decimals ? digits.slice(-decimals).slice(0, 8).replace(/0+$/, "") : "";
  const formattedInteger = BigInt(integer || "0").toLocaleString();
  return `${negative ? "-" : ""}${formattedInteger}${fraction ? `.${fraction}` : ""}`;
}

function quoteStatusLabel(quote: RunResponse["quotes"][number]) {
  if (quote.status === "unavailable") {
    if (quote.errorCode === "UNSUPPORTED_PAIR") return "Not supported";
    if (quote.errorCode === "INSUFFICIENT_LIQUIDITY") return "Insufficient liquidity";
    if (quote.errorCode === "STRATEGY_UNAVAILABLE") return "No quote for this mode";
    return "No quote at this size";
  }
  if (quote.status === "error") return "Quote error";
  return quote.status;
}

function ComparisonResult({ cell, window, now }: { cell?: ComparisonCell; window: ViewWindow; now: number }) {
  if (!cell) return <span className="cell-empty"><b>—</b><small>Awaiting refresh</small></span>;
  if (!cell.leader) return <span className="cell-empty"><b>—</b><small>{cell.successfulQuotes === 1 ? "1 valid quote" : cell.successfulQuotes === 0 ? "No valid quote at this size" : cell.sampleCount ? "No valid quotes" : "Awaiting refresh"}</small></span>;
  const partner = partners.find((item) => item.id === cell.leader)!;
  if (window !== "now") {
    return <span className={`cell-result protocol-${cell.leader}`}><span><PartnerMark id={cell.leader} /><b>{partner.cellName}</b></span><strong>{Math.round((cell.winRate ?? 0) * 100)}% wins</strong><small>avg {formatBps(cell.averageOracleGapBps)} vs oracle · {cell.sampleCount ?? 0} checks</small></span>;
  }
  const quoteCount = cell.successfulQuotes ?? 0;
  return <span className={`cell-result protocol-${cell.leader}`}><span><PartnerMark id={cell.leader} /><b>{cell.tie ? "Tie" : partner.cellName}</b></span><strong>{cell.marginBps == null ? "ONLY QUOTE" : cell.tie ? "Exact tie" : formatBps(cell.marginBps)}{cell.marginBps != null && cell.runnerUp && !cell.tie && <span className="margin-context">vs <PartnerMark id={cell.runnerUp} /></span>}</strong><small>{formatBps(cell.oracleGapBps)} vs oracle · {quoteCount} {quoteCount === 1 ? "quote" : "quotes"} · {formatAgeLabel(cell.capturedAt, now)}</small></span>;
}

function MobileRouteCard({ route, selectedSize, cells, viewWindow, now, enabledProtocols, onInspect }: {
  route: Route;
  selectedSize: QuoteSize;
  cells: Map<string, ComparisonCell>;
  viewWindow: ViewWindow;
  now: number;
  enabledProtocols: PartnerId[];
  onInspect: (route: Route, size: QuoteSize) => void;
}) {
  const selectedCell = cells.get(`${route.id}::${selectedSize.id}`);
  const activeRoutePartnerCount = route.partners.filter((partner) => enabledProtocols.includes(partner)).length;
  return <article className="mobile-route-card">
    <button className="mobile-route-card-header" onClick={() => onInspect(route, selectedSize)} aria-label={`Inspect ${route.source.symbol} to ${route.destination.symbol}`}>
      <LeaderboardRoutePath route={route} />
      <span className="mobile-route-cta" aria-hidden="true">Analyze <i>→</i></span>
    </button>
    <div className="mobile-route-card-summary">
      <div className="mobile-route-card-label"><span>Top quote at {selectedSize.label}</span><b>Open details ↓</b></div>
      <button className="mobile-result-button" onClick={() => onInspect(route, selectedSize)} aria-label={`Inspect ${route.source.symbol} to ${route.destination.symbol} at ${selectedSize.label}`}>
        <ComparisonResult cell={selectedCell} window={viewWindow} now={now} />
      </button>
      <div className="mobile-route-coverage"><span>{activeRoutePartnerCount} protocols compared</span><div>{partners.map((partner) => <PartnerMark key={partner.id} id={partner.id} muted={!route.partners.includes(partner.id) || !enabledProtocols.includes(partner.id)} />)}</div></div>
    </div>
  </article>;
}

function LatestQuoteComparison({ route, runDetails, runLoading, selectedSize, onOpenDetails }: {
  route: Route;
  runDetails: RunResponse | null;
  runLoading: boolean;
  selectedSize: QuoteSize;
  onOpenDetails: () => void;
}) {
  const orderedQuotes = [...(runDetails?.quotes ?? [])].sort((a, b) => partners.findIndex((partner) => partner.id === a.protocol) - partners.findIndex((partner) => partner.id === b.protocol));
  const quotedOutputs = orderedQuotes
    .filter((quote) => quote.status === "quoted" && quote.expectedOutputFormatted)
    .map((quote) => Number(quote.expectedOutputFormatted))
    .filter((value) => Number.isFinite(value));
  const bestOutput = quotedOutputs.length ? Math.max(...quotedOutputs) : null;
  const exactInput = runDetails?.run ? formatBaseUnits(runDetails.run.sourceAmountBaseUnits, route.source.decimals) : null;

  return <section className="latest-comparison" aria-labelledby="latest-comparison-title" aria-busy={runLoading}>
    <header>
      <div><b id="latest-comparison-title">Latest quote comparison</b><span>{selectedSize.label}{runDetails?.run ? ` · captured ${formatTime(runDetails.run.initiatedAt)}` : " · synchronized batch"}</span></div>
      <button className="quote-audit-link" type="button" onClick={onOpenDetails}><span>Raw details</span><b aria-hidden="true">→</b></button>
    </header>
    {runLoading ? <div className="latest-comparison-state" role="status"><b>Loading latest quotes…</b><span>Reading the synchronized batch for {selectedSize.label}.</span></div> : runDetails?.run ? <>
      <div className="latest-comparison-row">
        <div className="latest-input-card">
          <small>Exact input</small>
          <strong>{exactInput} <span>{route.source.symbol}</span></strong>
          <b>{selectedSize.label} benchmark</b>
        </div>
        <div className="latest-quote-results">
          {orderedQuotes.map((quote) => {
            const output = quote.status === "quoted" && quote.expectedOutputFormatted ? Number(quote.expectedOutputFormatted) : null;
            const isQuoted = output != null && Number.isFinite(output);
            const isWinner = isQuoted && bestOutput != null && output === bestOutput;
            const gapBps = isQuoted && bestOutput ? (output / bestOutput - 1) * 10_000 : null;
            const oracleContext = quote.oracleGapBps != null ? `${formatBps(quote.oracleGapBps)} vs oracle` : "Oracle unavailable";
            return <article key={quote.id} className={`latest-quote-card protocol-${quote.protocol} ${isWinner ? "winner" : ""}`}>
              <div><PartnerMark id={quote.protocol} /><b>{partners.find((partner) => partner.id === quote.protocol)?.cellName}</b>{isWinner && <em>Best</em>}</div>
              {isQuoted ? <strong>{formatTokenAmount(quote.expectedOutputFormatted)} <span>{route.destination.symbol}</span></strong> : <strong className="quote-unavailable">{quoteStatusLabel(quote)}</strong>}
              <small>{isWinner ? `${oracleContext} · Best output` : gapBps != null ? `${oracleContext} · ${formatBps(gapBps)} vs best` : quote.errorCode ?? quote.status}{quote.responseLatencyMs != null ? ` · ${quote.responseLatencyMs} ms` : ""}</small>
            </article>;
          })}
        </div>
      </div>
    </> : <div className="latest-comparison-state"><b>{runDetails?.error ? "Latest comparison unavailable" : "No captured comparison yet"}</b><span>{runDetails?.error ? "Quote history could not be loaded. Raw details contain the diagnostic response." : `The next ${selectedSize.label} quote batch will appear here.`}</span></div>}
  </section>;
}

function RequestDetails({ runDetails, runLoading, selectedSize, historical = false, onNavigate }: { runDetails: RunResponse | null; runLoading: boolean; selectedSize: QuoteSize; historical?: boolean; onNavigate: (runId: number) => void }) {
  const winnerProtocol = [...(runDetails?.quotes ?? [])]
    .filter((quote) => quote.status === "quoted" && quote.expectedOutputFormatted)
    .sort((a, b) => Number(b.expectedOutputFormatted) - Number(a.expectedOutputFormatted))[0]?.protocol;
  const orderedQuotes = [...(runDetails?.quotes ?? [])].sort((a, b) => partners.findIndex((partner) => partner.id === a.protocol) - partners.findIndex((partner) => partner.id === b.protocol));

  return <div className={`request-panel ${runDetails?.quotes.length ? "has-quotes" : ""}`}>
    <p className="eyebrow">{historical ? "Historical" : "Latest"} synchronized quotes · {selectedSize.label}</p>
    {runLoading ? <><h3>Loading requests…</h3><p>Reading the synchronized batch and its archived raw payloads.</p></> : runDetails?.run ? <>
      <h3>{runDetails.quotes.length} protocol results</h3>
      <p>Captured {formatTime(runDetails.run.initiatedAt)} · ${runDetails.run.sourceAmountUsd.toLocaleString()} exact input · synchronized within {runDetails.run.maxRequestSkewMs ?? "—"} ms</p>
      <nav className="request-history-nav" aria-label="Raw quote history">
        <button type="button" disabled={runLoading || !runDetails.navigation?.previous} onClick={() => runDetails.navigation?.previous && onNavigate(runDetails.navigation.previous.runId)} title={runDetails.navigation?.previous ? `Previous batch: ${formatTime(runDetails.navigation.previous.initiatedAt)}` : "No earlier raw batch available"}>← Previous</button>
        <span><b>{historical ? "Archived batch" : "Latest batch"}</b><small>Raw history is retained for {rawArchiveRetentionDays} days</small></span>
        <button type="button" disabled={runLoading || !runDetails.navigation?.next} onClick={() => runDetails.navigation?.next && onNavigate(runDetails.navigation.next.runId)} title={runDetails.navigation?.next ? `Next batch: ${formatTime(runDetails.navigation.next.initiatedAt)}` : "No newer raw batch available"}>Next →</button>
      </nav>
      {runDetails.rawDetailsAvailable === false && <p>Raw payloads are unavailable for this batch. Normalized quote results are still shown below.</p>}
      <div className="request-list">{orderedQuotes.map((quote) => <details key={quote.id}>
        <summary><PartnerMark id={quote.protocol} /><span><b>{partners.find((partner) => partner.id === quote.protocol)?.name}</b><small>{quote.protocol === "chainflip" && runDetails.run?.mode === "optimized" && quote.strategy === "regular" ? "regular fallback" : quote.strategy} · {quote.responseLatencyMs ?? "—"} ms</small></span><strong className={winnerProtocol === quote.protocol ? "winner" : ""}>{winnerProtocol === quote.protocol ? "Best output" : quoteStatusLabel(quote)}</strong></summary>
        <dl><div><dt>Requested</dt><dd>{formatTime(quote.requestStartedAt)}</dd></div><div><dt>HTTP status</dt><dd>{quote.responseHttpStatus ?? "—"}</dd></div><div><dt>Expected output</dt><dd>{quote.expectedOutputFormatted ?? quote.expectedOutputBaseUnits ?? "—"}</dd></div><div><dt>Oracle deviation</dt><dd>{quote.oracleGapBps == null ? "—" : formatBps(quote.oracleGapBps)}</dd></div><div><dt>Quote expiry</dt><dd>{formatTime(quote.quoteExpiresAt ?? undefined)}</dd></div></dl>
        <span className="json-label">Request</span><pre>{quote.requestPayloadJson ?? quote.requestUrl ?? "No request payload stored"}</pre><span className="json-label">Response</span><pre>{quote.rawResponseJson ?? quote.errorMessage ?? "No response payload stored"}</pre>
      </details>)}</div>
    </> : <><h3>No captured requests yet</h3><p>{runDetails?.error ?? "The latest scheduled quote refresh for this route, size, and execution mode will appear here when available."}</p><dl><div><dt>Request timestamp</dt><dd>—</dd></div><div><dt>Exact input amount</dt><dd>{selectedSize.label}</dd></div><div><dt>Raw request / response</dt><dd>Available after collection</dd></div></dl></>}
  </div>;
}

function TrendChart({ data, activePartners }: { data: TrendResponse; activePartners: typeof partners }) {
  const width = 920;
  const height = 300;
  const padding = { top: 24, right: 18, bottom: 30, left: 58 };
  const plotted = data.buckets.flatMap((bucket) => bucket.points.flatMap((point) => {
    const value = point.oracleGapBps;
    return value == null ? [] : [{ timestamp: bucket.timestamp, value, point }];
  }));
  if (!plotted.length) return <div className="trend-empty"><b>No oracle-backed quote yet</b><span>Run this exact route and size once to start the chart.</span></div>;

  const deviations = plotted.map((point) => Math.abs(point.value)).sort((a, b) => a - b);
  const percentile = deviations[Math.min(deviations.length - 1, Math.floor(deviations.length * 0.95))] ?? 5;
  const bound = Math.max(5, Math.ceil(Math.min(percentile * 1.15, 1_000) / 5) * 5);
  const start = new Date(data.startAt).getTime();
  const end = new Date(data.endAt).getTime();
  const x = (timestamp: number) => padding.left + ((timestamp - start) / Math.max(1, end - start)) * (width - padding.left - padding.right);
  const y = (value: number) => padding.top + ((bound - Math.max(-bound, Math.min(bound, value))) / (bound * 2)) * (height - padding.top - padding.bottom);
  const ticks = [bound, bound / 2, 0, -bound / 2, -bound];

  const series = activePartners.map((partner) => ({
    partner,
    points: data.buckets.flatMap((bucket) => {
      const point = bucket.points.find((item) => item.protocol === partner.id);
      const value = point?.oracleGapBps ?? null;
      return point && value != null ? [{ timestamp: bucket.timestamp, value, point }] : [];
    }),
  }));

  return <div className="trend-visual">
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${data.days === 1 ? "24-hour" : `${data.days}-day`} quote deviation in basis points from the THORChain CEX-derived oracle`}>
      <text className="axis-title" x={padding.left} y="11">BPS VS ORACLE</text>
      {ticks.map((value) => <g key={value}><line x1={padding.left} x2={width - padding.right} y1={y(value)} y2={y(value)} className={value === 0 ? "zero-line" : "grid-line"} /><text x={padding.left - 9} y={y(value) + 3} textAnchor="end">{Number.isInteger(value) ? value : value.toFixed(1)}</text></g>)}
      <text x={padding.left} y={height - 7}>{new Date(start).toLocaleString([], data.days === 1 ? { hour: "numeric", minute: "2-digit" } : { month: "short", day: "numeric" })}</text>
      <text x={width - padding.right} y={height - 7} textAnchor="end">{new Date(end).toLocaleString([], data.days === 1 ? { hour: "numeric", minute: "2-digit" } : { month: "short", day: "numeric" })}</text>
      {series.map(({ partner, points }) => {
        const segments: typeof points[] = [];
        for (const point of points) {
          const current = segments[segments.length - 1];
          if (!current || point.timestamp - current[current.length - 1].timestamp > data.bucketMs * 1.5) segments.push([point]);
          else current.push(point);
        }
        return <g key={partner.id}>{segments.map((segment, index) => <polyline key={index} points={segment.map((point) => `${x(point.timestamp)},${y(point.value)}`).join(" ")} fill="none" stroke={partner.color} strokeWidth="2.5" vectorEffect="non-scaling-stroke" />)}{points.map((point) => <circle key={point.timestamp} cx={x(point.timestamp)} cy={y(point.value)} r={data.pointMode === "comparison" && point.point.winRate ? "4" : "3"} fill={partner.color}><title>{partner.name} · {formatBps(point.value)} vs oracle · {trendPointContext(point.point, data.pointMode)}</title></circle>)}</g>;
      })}
    </svg>
    <div className="trend-legend">{activePartners.map((partner) => {
      const summary = data.summary.find((item) => item.protocol === partner.id);
      return <span key={partner.id}><i style={{ background: partner.color }} /><b>{partner.name}</b><small>{summary?.sampleCount ? `${Math.round((summary.winRate ?? 0) * 100)}% wins · ${formatBps(summary.averageOracleGapBps)} avg vs oracle · ${Math.round(summary.availability * 100)}% availability` : "No data"}</small></span>;
    })}</div>
  </div>;
}

function DepthForecastChart({ forecast }: { forecast: NonNullable<RunResponse["depthForecast"]> }) {
  const points = forecast.curve ?? [];
  if (!points.length) return <div className="depth-forecast-empty"><b>Forecast curve unavailable</b><span>The next synchronized sweep will retry the simulation.</span></div>;
  const width = 920;
  const height = 280;
  const padding = { top: 25, right: 22, bottom: 40, left: 62 };
  const minimumMultiplier = Math.min(...points.map((point) => point.multiplier));
  const maximumMultiplier = Math.max(...points.map((point) => point.multiplier));
  const gaps = [...points.map((point) => point.gapBps), -forecast.competitiveWithinBps, 0];
  const minimumGap = Math.min(...gaps);
  const maximumGap = Math.max(...gaps);
  const gapPadding = Math.max(5, (maximumGap - minimumGap) * 0.08);
  const yMinimum = minimumGap - gapPadding;
  const yMaximum = maximumGap + gapPadding;
  const x = (value: number) => padding.left + (Math.log(value / minimumMultiplier) / Math.log(maximumMultiplier / minimumMultiplier)) * (width - padding.left - padding.right);
  const y = (value: number) => padding.top + ((yMaximum - value) / Math.max(1, yMaximum - yMinimum)) * (height - padding.top - padding.bottom);
  const required = forecast.requiredDepthMultiplier;
  const xTicks = [...new Set([minimumMultiplier, 1, ...(required && required > 1 ? [required] : []), maximumMultiplier])].sort((left, right) => left - right);
  const yTicks = [...new Set([Math.round(minimumGap), -forecast.competitiveWithinBps, 0, Math.round(maximumGap)])].sort((left, right) => right - left);
  return <div className="depth-curve">
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Projected THORChain quote gap as both route pool depths increase">
      <text className="axis-title" x={padding.left} y="11">MODELED THORCHAIN GAP VS BEST DEX</text>
      {yTicks.map((value) => <g key={value}><line x1={padding.left} x2={width - padding.right} y1={y(value)} y2={y(value)} className={value === -forecast.competitiveWithinBps ? "target-line" : value === 0 ? "zero-line" : "grid-line"} /><text x={padding.left - 9} y={y(value) + 3} textAnchor="end">{value} bps</text></g>)}
      <polyline points={points.map((point) => `${x(point.multiplier)},${y(point.gapBps)}`).join(" ")} fill="none" className="forecast-line" vectorEffect="non-scaling-stroke" />
      {points.map((point) => <circle key={point.multiplier} cx={x(point.multiplier)} cy={y(point.gapBps)} r={Math.abs(point.multiplier - 1) < 1e-6 ? 5 : required && Math.abs(point.multiplier - required) < 1e-6 ? 5 : 3} className={Math.abs(point.multiplier - 1) < 1e-6 ? "current-point" : required && Math.abs(point.multiplier - required) < 1e-6 ? "target-point" : "curve-point"}><title>{point.multiplier.toFixed(2)}× depth · {formatBps(point.gapBps)} vs best DEX</title></circle>)}
      {xTicks.map((value) => <text key={value} x={x(value)} y={height - 10} textAnchor={value === minimumMultiplier ? "start" : value === maximumMultiplier ? "end" : "middle"}>{value.toFixed(value < 10 ? 2 : 0)}×</text>)}
    </svg>
    <div className="depth-curve-legend"><span><i className="current" />Current depth</span><span><i className="target" />Within {forecast.competitiveWithinBps} bps</span></div>
  </div>;
}

function DepthForecastCard({ route, runDetails, runLoading, selectedSize }: { route: Route; runDetails: RunResponse | null; runLoading: boolean; selectedSize: QuoteSize }) {
  const forecast = runDetails?.depthForecast;
  if (runLoading) return <section className="depth-forecast-card"><div className="depth-forecast-empty"><b>Loading depth forecast…</b><span>Reading the synchronized THORChain pool snapshot.</span></div></section>;
  if (!forecast || forecast.status !== "available" || !forecast.sourcePool || !forecast.destinationPool) return <section className="depth-forecast-card"><div className="depth-forecast-empty"><b>Depth forecast unavailable</b><span>{forecast?.reason ?? "A forecast will appear after the next completed quote sweep captures pool depths."}</span></div></section>;
  const bestPartner = partners.find((partner) => partner.id === forecast.bestProtocol);
  const bindingLabel = forecast.bindingPool === "source" ? `${route.source.symbol} source pool` : forecast.bindingPool === "destination" ? `${route.destination.symbol} destination pool` : "Both route pools";
  const competitiveNow = (forecast.currentGapBps ?? -Infinity) >= -forecast.competitiveWithinBps;
  const poolRateCompetitive = (forecast.poolRateGapVsBestBps ?? -Infinity) >= -forecast.competitiveWithinBps;
  const statusLabel = competitiveNow
    ? "Competitive now"
    : poolRateCompetitive
      ? "Execution constrained"
      : "Pool price + execution constrained";
  const oracleOutput = forecast.oracleRate != null && forecast.sourceAmountFormatted != null
    ? forecast.oracleRate * forecast.sourceAmountFormatted
    : null;
  const currentOracleGapBps = forecast.currentOracleGapBps ?? (oracleOutput && forecast.currentThorOutput
    ? (forecast.currentThorOutput / oracleOutput - 1) * 10_000
    : null);
  const executionDragVsOracleBps = forecast.executionDragVsOracleBps ?? (currentOracleGapBps != null && forecast.poolRateGapVsOracleBps != null
    ? currentOracleGapBps - forecast.poolRateGapVsOracleBps
    : null);
  const executionCostVsOracleBps = forecast.executionCostVsOracleBps ?? (executionDragVsOracleBps == null ? null : Math.max(0, -executionDragVsOracleBps));
  const reportedSlippageVsOracleBps = forecast.reportedSlippageVsOracleBps ?? forecast.reportedSlippageBps;
  const liquidityFeeVsOracleBps = forecast.liquidityFeeVsOracleBps ?? forecast.liquidityFeeBps;
  const outboundFeeVsOracleBps = forecast.outboundFeeVsOracleBps ?? forecast.outboundFeeBps;
  const unexplainedExecutionCostVsOracleBps = forecast.unexplainedExecutionCostVsOracleBps ?? forecast.unexplainedExecutionCostBps;
  const hasRateDecomposition = forecast.poolImpliedRate != null && forecast.poolRateGapVsOracleBps != null && currentOracleGapBps != null && executionDragVsOracleBps != null && executionCostVsOracleBps != null;
  const quoteGap = forecast.currentGapBps ?? 0;
  const headline = competitiveNow
    ? `THOR is within ${forecast.competitiveWithinBps} bps of ${bestPartner?.name ?? "the best DEX"}`
    : `THOR is ${Math.abs(Math.round(quoteGap))} bps behind ${bestPartner?.name ?? "the best DEX"}`;
  const poolRateDirection = (forecast.poolRateGapVsOracleBps ?? 0) >= 0 ? "above" : "below";
  const conclusion = hasRateDecomposition
    ? `THOR's pool rate starts ${Math.abs(Math.round(forecast.poolRateGapVsOracleBps ?? 0))} bps ${poolRateDirection} its oracle. About ${Math.round(executionCostVsOracleBps)} bps of execution impact and fees move the executable quote to ${formatBps(currentOracleGapBps)} versus oracle.`
    : "This compares the synchronized executable quotes returned by each protocol.";
  const poolRows = [
    { pool: forecast.sourcePool, symbol: route.source.symbol },
    { pool: forecast.destinationPool, symbol: route.destination.symbol },
  ];
  const effectiveQuoteRates = (runDetails?.quotes ?? []).flatMap((quote) => {
    const output = Number(quote.expectedOutputFormatted);
    if (quote.status !== "quoted" || !Number.isFinite(output) || output <= 0 || !forecast.sourceAmountFormatted) return [];
    return [{ ...quote, rate: output / forecast.sourceAmountFormatted }];
  });
  const singlePoolScenarios = poolRows.filter(({ pool }) => pool.requiredMultiplierIfScaledAlone != null && pool.requiredAdditionalLiquidityUsd != null);
  const cheapestSinglePoolScenario = [...singlePoolScenarios].sort((left, right) => (left.pool.requiredAdditionalLiquidityUsd ?? Infinity) - (right.pool.requiredAdditionalLiquidityUsd ?? Infinity))[0];
  const combinedScenarioFormula = forecast.requiredDepthMultiplier && forecast.requiredAdditionalLiquidityUsd != null
    ? `(${formatCompactUsd(forecast.sourcePool.liquidityUsd)} + ${formatCompactUsd(forecast.destinationPool.liquidityUsd)}) × (${forecast.requiredDepthMultiplier.toFixed(2)} − 1) = ${formatCompactUsd(forecast.requiredAdditionalLiquidityUsd)}`
    : null;
  return <section className="depth-forecast-card" aria-labelledby="depth-forecast-title">
    <header className="depth-forecast-header">
      <div><p className="eyebrow">Observed result · {selectedSize.label}</p><h3 id="depth-forecast-title">{headline}</h3><p>{conclusion}</p></div>
      <span className={`forecast-status ${competitiveNow ? "competitive" : "modeled"}`}>{statusLabel}</span>
    </header>
    {hasRateDecomposition && <section className="rate-decomposition" aria-labelledby="rate-decomposition-title">
      <header><div><p className="eyebrow">Why the quote lands here</p><h4 id="rate-decomposition-title">Pool rate − execution costs = final quote</h4></div><span>All values vs oracle</span></header>
      <div className="quote-explanation-flow">
        <article className={(forecast.poolRateGapVsOracleBps ?? 0) >= 0 ? "positive" : "cost"}><small>Pool rate before the trade</small><strong>{formatBps(forecast.poolRateGapVsOracleBps)}</strong><span><b>Calculated</b> from pool balances vs oracle</span></article>
        <i aria-hidden="true">+</i>
        <article className="cost"><small>Trade impact + fees</small><strong>{formatBps(executionDragVsOracleBps)}</strong><span><b>Derived</b> from pool rate to actual quote</span></article>
        <i aria-hidden="true">=</i>
        <article><small>Executable THOR quote</small><strong>{formatBps(currentOracleGapBps)}</strong><span><b>Observed</b> output compared with oracle</span></article>
      </div>
      <div className="execution-cost-breakdown">
        <span><small>THOR-reported price impact</small><strong>{reportedSlippageVsOracleBps == null ? "Not reported" : `≈ ${formatBps(-reportedSlippageVsOracleBps)}`}</strong></span>
        <span><small>THOR-reported liquidity fee</small><strong>{liquidityFeeVsOracleBps == null ? "Not reported" : formatBps(-liquidityFeeVsOracleBps)}</strong></span>
        <span><small>Outbound network fee</small><strong>{outboundFeeVsOracleBps == null ? "—" : formatBps(-outboundFeeVsOracleBps)}</strong></span>
        <span><small>Unexplained / rounding</small><strong>{unexplainedExecutionCostVsOracleBps == null ? "—" : formatBps(-unexplainedExecutionCostVsOracleBps)}</strong></span>
      </div>
      <div className="competitive-result"><span><small>Separate competitive comparison</small><b>Executable THOR quote vs {bestPartner?.name ?? "best DEX"}</b></span><strong>{formatBps(forecast.currentGapBps)}</strong></div>
    </section>}
    {hasRateDecomposition && <section className="pool-rate-panel" aria-labelledby="pool-rate-title">
      <header><div><p className="eyebrow">Pool-implied exchange rate</p><h4 id="pool-rate-title">1 {route.source.symbol} priced in {route.destination.symbol}</h4></div><span>{formatBps(forecast.poolRateGapVsOracleBps)} vs oracle</span></header>
      <div className="effective-rate-wrap"><table className="effective-rate-table">
        <thead><tr><th>Rate source</th><th>Rate type</th><th>1 {route.source.symbol} equals</th><th>Deviation from oracle</th></tr></thead>
        <tbody>
          <tr className="reference"><th><span className="rate-source"><i className="oracle-rate-mark" />Oracle</span></th><td>THORChain enshrined CEX reference</td><td><strong>{formatExchangeRate(forecast.oracleRate)} {route.destination.symbol}</strong></td><td><b>0 bps</b></td></tr>
          <tr className="pool-rate"><th><span className="rate-source"><PartnerMark id="thorchain" />THORCHAIN</span></th><td>Pool rate before trade impact</td><td><strong>{formatExchangeRate(forecast.poolImpliedRate)} {route.destination.symbol}</strong></td><td><b>{formatBps(forecast.poolRateGapVsOracleBps)}</b></td></tr>
          {effectiveQuoteRates.map((quote) => {
            const partner = partners.find((candidate) => candidate.id === quote.protocol);
            const isBest = quote.protocol === forecast.bestProtocol;
            return <tr key={quote.protocol} className={isBest ? "best" : ""}><th><span className="rate-source"><PartnerMark id={quote.protocol} />{partner?.name ?? quote.protocol}</span></th><td>Executable {quote.strategy} quote{isBest ? <em>Best</em> : null}</td><td><strong>{formatExchangeRate(quote.rate)} {route.destination.symbol}</strong></td><td><b>{formatBps(quote.oracleGapBps)}</b></td></tr>;
          })}
        </tbody>
      </table></div>
      <p><b>How to read this:</b> The pool row is THORChain&apos;s starting exchange rate before this trade changes the pools. The executable rows are what each venue actually offered for this exact amount. A favorable pool rate can still produce a losing quote when price impact and fees are larger.</p>
    </section>}
    <details className="liquidity-scenario">
      <summary>
        <span><small>Experimental symmetric scenario</small><strong>{competitiveNow ? "Already within target" : forecast.depthAloneSufficient && forecast.requiredDepthMultiplier ? `About ${forecast.requiredDepthMultiplier.toFixed(1)}× in both pools` : "Depth alone is not enough"}</strong></span>
        <span><b>Low confidence</b><small>{forecast.depthAloneSufficient ? `${formatCompactUsd(forecast.requiredAdditionalLiquidityUsd)} added across both pools to reach the ${forecast.competitiveWithinBps} bps target` : `${formatBps(forecast.priceRebalanceBps)} pool-rate improvement still needed`}</small></span>
      </summary>
      <div className="scenario-explainer"><b>This is a sensitivity estimate, not a prediction or capital recommendation.</b><span>The symmetric scenario multiplies the asset and RUNE balances of both pools by the same factor, preserving their pool rates, then finds the first factor whose modeled quote is within {forecast.competitiveWithinBps} bps of the best DEX. {combinedScenarioFormula && <>For this snapshot: <strong>{combinedScenarioFormula}</strong>. </>}{cheapestSinglePoolScenario && <>This is not the cheapest allocation: the separate {cheapestSinglePoolScenario.symbol}-only scenario below reaches the target with {formatCompactUsd(cheapestSinglePoolScenario.pool.requiredAdditionalLiquidityUsd)} modeled additional liquidity.</>}</span></div>
      <DepthForecastChart forecast={forecast} />
      <div className="depth-pool-table">
        <div className="depth-pool-row heading"><span>Pool leg</span><span>Current liquidity</span><span>Scenario if scaled alone</span><span>Additional liquidity</span></div>
        {poolRows.map(({ pool, symbol }) => <div className={`depth-pool-row ${forecast.bindingPool === pool.role ? "binding" : ""}`} key={pool.asset}><span><b>{symbol}</b><small>{pool.role} leg{forecast.bindingPool === pool.role ? " · most sensitive" : ""}</small></span><strong>{formatCompactUsd(pool.liquidityUsd)}</strong><strong>{pool.requiredMultiplierIfScaledAlone == null ? "Not sufficient alone" : `~${pool.requiredMultiplierIfScaledAlone.toFixed(1)}×`}</strong><strong>{formatCompactUsd(pool.requiredAdditionalLiquidityUsd)}</strong></div>)}
      </div>
      <div className="depth-model-note"><b>Low-confidence model</b><span>{forecast.estimateConfidenceReason ?? "Single-snapshot counterfactual; not historically backtested."} {bindingLabel} is most sensitive in this scenario. The model preserves current pool prices and uses the observed outbound fee and streaming quantity.</span><small>Pool snapshot {formatTime(forecast.capturedAt)} · {forecast.modelVersion}</small></div>
    </details>
  </section>;
}

export default function SwapRankDashboard({
  view,
  initialRouteId,
  initialQuery,
}: {
  view: DashboardView;
  initialRouteId?: string;
  initialQuery: NormalizedDashboardQuery;
}) {
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [enabledProtocols, setEnabledProtocols] = useState<PartnerId[]>(initialQuery.protocols);
  const [selectedAssetIds, setSelectedAssetIds] = useState<string[]>(initialQuery.assets);
  const [analysisPanel, setAnalysisPanel] = useState<AnalysisPanel>("performance");
  const [executionMode, setExecutionMode] = useState<ExecutionMode>(initialQuery.mode);
  const [viewWindow, setViewWindow] = useState<ViewWindow>(initialQuery.window);
  const [comparison, setComparison] = useState<ComparisonResponse | null>(null);
  const [comparisonLoading, setComparisonLoading] = useState(view === "leaderboard");
  const [selectedRoute, setSelectedRoute] = useState<Route | null>(null);
  const [selectedSize, setSelectedSize] = useState<QuoteSize>(() => quoteSizes.find((size) => size.id === initialQuery.sizeId) ?? quoteSizes[3]);
  const [runDetails, setRunDetails] = useState<RunResponse | null>(null);
  const [runLoading, setRunLoading] = useState(false);
  const [auditDetails, setAuditDetails] = useState<RunResponse | null>(null);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditRunId, setAuditRunId] = useState<number | null>(null);
  const [requestsOpen, setRequestsOpen] = useState(false);
  const [trendDays, setTrendDays] = useState<TrendDays>(initialQuery.days);
  const [trend, setTrend] = useState<TrendResponse | null>(null);
  const [trendLoading, setTrendLoading] = useState(false);
  const [trendError, setTrendError] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [theme, setTheme] = useState<Theme>("dark");
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const [assetMenuOpen, setAssetMenuOpen] = useState(false);
  const [visibleAssetCount, setVisibleAssetCount] = useState(2);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [manualRefreshAvailableAt, setManualRefreshAvailableAt] = useState(0);
  const enabledProtocolsRef = useRef(enabledProtocols);
  const selectedAssetIdsRef = useRef(selectedAssetIds);
  const lastRefreshRequestedAt = useRef(0);
  const auditRequest = useRef<AbortController | null>(null);
  const assetMenu = useRef<HTMLDivElement | null>(null);
  const assetSummaryBox = useRef<HTMLSpanElement | null>(null);
  const assetSummaryMeasure = useRef<HTMLSpanElement | null>(null);
  const activePartners = useMemo(() => partners.filter((partner) => enabledProtocols.includes(partner.id)), [enabledProtocols]);
  const protocolParam = enabledProtocols.join(",");
  const availableAssets = useMemo(() => Array.from(new Map((catalog?.routes ?? [])
    .flatMap((route) => [route.source, route.destination])
    .map((asset) => [asset.id, asset])).values())
    .sort((left, right) => left.symbol.localeCompare(right.symbol) || left.chain.localeCompare(right.chain)), [catalog?.routes]);
  const ambiguousAssetSymbols = useMemo(() => {
    const counts = new Map<string, number>();
    for (const asset of availableAssets) counts.set(asset.symbol, (counts.get(asset.symbol) ?? 0) + 1);
    return new Set(Array.from(counts).filter(([, count]) => count > 1).map(([symbol]) => symbol));
  }, [availableAssets]);
  const filteredRoutes = useMemo(() => {
    const routes = catalog?.routes ?? [];
    const selectedAssets = new Set(selectedAssetIds);
    const selectedProtocols = new Set(enabledProtocols);
    return routes.filter((route) => routeMatchesAssets(route, selectedAssets) && routeMatchesProtocols(route, selectedProtocols));
  }, [catalog?.routes, enabledProtocols, selectedAssetIds]);
  const assetSummary = selectedAssetIds.length === 0
    ? "All assets"
    : selectedAssetIds.length <= 2
      ? selectedAssetIds.map((id) => {
        const asset = availableAssets.find((item) => item.id === id);
        return asset ? `${asset.symbol} · ${chainLabel(asset.chain)}` : id;
      }).join(" + ")
      : `${selectedAssetIds.length} assets`;
  const selectedAssets = selectedAssetIds.flatMap((id) => {
    const asset = availableAssets.find((item) => item.id === id);
    return asset ? [asset] : [];
  });
  const selectedAssetKey = selectedAssetIds.join("|");

  useLayoutEffect(() => {
    const summary = assetSummaryBox.current;
    const measure = assetSummaryMeasure.current;
    if (!summary || !measure || selectedAssets.length === 0) return;

    const updateVisibleAssets = () => {
      const availableWidth = summary.clientWidth;
      const chipWidths = Array.from(measure.querySelectorAll<HTMLElement>("[data-asset-chip]"), (chip) => chip.offsetWidth);
      const moreWidths = new Map(Array.from(measure.querySelectorAll<HTMLElement>("[data-asset-more]"), (chip) => [Number(chip.dataset.assetMore), chip.offsetWidth]));
      const gap = 5;
      const fullWidth = chipWidths.reduce((sum, width) => sum + width, 0) + gap * Math.max(0, chipWidths.length - 1);

      if (fullWidth <= availableWidth) {
        setVisibleAssetCount(chipWidths.length);
        return;
      }

      let usedWidth = 0;
      let count = 0;
      for (const width of chipWidths) {
        const nextCount = count + 1;
        const nextUsedWidth = usedWidth + (count ? gap : 0) + width;
        const remaining = chipWidths.length - nextCount;
        const moreWidth = moreWidths.get(remaining) ?? 0;
        if (nextUsedWidth + gap + moreWidth > availableWidth) break;
        usedWidth = nextUsedWidth;
        count = nextCount;
      }
      setVisibleAssetCount(count);
    };

    updateVisibleAssets();
    const observer = new ResizeObserver(updateVisibleAssets);
    observer.observe(summary);
    return () => observer.disconnect();
  }, [selectedAssetKey, selectedAssets.length]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      try {
        const response = await fetch("/api/routes", { signal: controller.signal, cache: "no-store" });
        const data = await response.json() as CatalogResponse;
        if (!response.ok) throw new Error(data.error ?? "Route catalog unavailable");
        setCatalog(data);
        setSelectedRoute(view === "analysis"
          ? data.routes.find((route) => route.id === initialRouteId) ?? null
          : null);
      } catch (error) {
        if (!controller.signal.aborted) setCatalog({ error: error instanceof Error ? error.message : "Route catalog unavailable" } as CatalogResponse);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 200);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [initialRouteId, refreshVersion, view]);

  useEffect(() => {
    if (view !== "leaderboard") return;
    const refresh = () => fetch("/api/health", { cache: "no-store" })
      .then(async (response) => setHealth(await response.json() as HealthResponse))
      .catch(() => setHealth({ status: "unhealthy", checkedAt: new Date().toISOString(), latestSweep: null, minutesSinceTerminalSweep: null, error: "Health endpoint unavailable" }));
    refresh();
    const clockTimer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(clockTimer);
  }, [refreshVersion, view]);

  useEffect(() => {
    if (!manualRefreshAvailableAt) return;
    const remaining = manualRefreshAvailableAt - Date.now();
    if (remaining <= 0) {
      Promise.resolve().then(() => setManualRefreshAvailableAt(0));
      return;
    }
    const timer = window.setTimeout(() => setManualRefreshAvailableAt(0), remaining);
    return () => window.clearTimeout(timer);
  }, [manualRefreshAvailableAt]);

  useEffect(() => {
    lastRefreshRequestedAt.current = Date.now();
    const refreshIfVisibleAndStale = () => {
      if (document.visibilityState !== "visible" || Date.now() - lastRefreshRequestedAt.current < resumeRefreshThresholdMs) return;
      lastRefreshRequestedAt.current = Date.now();
      setRefreshVersion((current) => current + 1);
    };
    const refreshTimer = window.setInterval(refreshIfVisibleAndStale, pageRefreshIntervalMs);
    document.addEventListener("visibilitychange", refreshIfVisibleAndStale);
    window.addEventListener("focus", refreshIfVisibleAndStale);
    return () => {
      window.clearInterval(refreshTimer);
      document.removeEventListener("visibilitychange", refreshIfVisibleAndStale);
      window.removeEventListener("focus", refreshIfVisibleAndStale);
    };
  }, []);

  useEffect(() => {
    if (view !== "leaderboard") return;
    const controller = new AbortController();
    Promise.resolve().then(() => { if (!controller.signal.aborted) setComparisonLoading(true); });
    const params = new URLSearchParams({ window: viewWindow, mode: executionMode, protocols: protocolParam });
    fetch(`/api/comparison?${params}`, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        const data = await response.json() as ComparisonResponse;
        if (!response.ok) throw new Error(data.error ?? "Comparison data unavailable");
        setComparison(data);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setComparison({ window: viewWindow, cells: [], error: error instanceof Error ? error.message : "Comparison data unavailable" });
      })
      .finally(() => { if (!controller.signal.aborted) setComparisonLoading(false); });
    return () => controller.abort();
  }, [executionMode, protocolParam, refreshVersion, view, viewWindow]);

  useEffect(() => {
    if (!selectedRoute) return;
    const controller = new AbortController();
    Promise.resolve().then(() => { if (!controller.signal.aborted) setRunLoading(true); });
    const params = new URLSearchParams({ routeId: selectedRoute.id, amountId: selectedSize.id, mode: executionMode });
    fetch(`/api/runs?${params}`, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        const data = await response.json() as RunResponse;
        if (!response.ok) throw new Error(data.error ?? "Quote history unavailable");
        setRunDetails(data);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setRunDetails({ run: null, quotes: [], error: error instanceof Error ? error.message : "Quote history unavailable" });
      })
      .finally(() => { if (!controller.signal.aborted) setRunLoading(false); });
    return () => controller.abort();
  }, [executionMode, refreshVersion, selectedRoute, selectedSize.id]);

  useEffect(() => {
    if (!selectedRoute) return;
    const controller = new AbortController();
    Promise.resolve().then(() => { if (!controller.signal.aborted) { setTrendLoading(true); setTrendError(null); } });
    const params = new URLSearchParams({ routeId: selectedRoute.id, amountId: selectedSize.id, mode: executionMode, days: String(trendDays), protocols: protocolParam, v: "4" });
    fetch(`/api/trends?${params}`, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        const data = await response.json() as TrendResponse;
        if (!response.ok) throw new Error(data.error ?? "Trend data unavailable");
        setTrend(data);
      })
      .catch((error) => {
        if (!controller.signal.aborted) { setTrend(null); setTrendError(error instanceof Error ? error.message : "Trend data unavailable"); }
      })
      .finally(() => { if (!controller.signal.aborted) setTrendLoading(false); });
    return () => controller.abort();
  }, [executionMode, protocolParam, refreshVersion, selectedRoute, selectedSize.id, trendDays]);

  useEffect(() => {
    const saved = window.localStorage.getItem("swaprank-theme");
    const initial = saved === "light" ? "light" : "dark";
    document.documentElement.dataset.theme = initial;
    Promise.resolve().then(() => setTheme(initial));
  }, []);

  useEffect(() => {
    if (!requestsOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      auditRequest.current?.abort();
      auditRequest.current = null;
      setAuditLoading(false);
      setRequestsOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [requestsOpen]);

  useEffect(() => {
    if (!assetMenuOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (!assetMenu.current?.contains(event.target as Node)) setAssetMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAssetMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [assetMenuOpen]);

  const cells = useMemo(() => new Map((comparison?.cells ?? []).map((cell) => [`${cell.pairId}::${cell.amountId}`, cell])), [comparison]);
  const trendLeaderPartner = partners.find((partner) => partner.id === trend?.leader?.protocol);
  const latestCheckAt = useMemo(() => {
    const timestamps = [
      ...(comparison?.cells ?? []).map((cell) => cell.capturedAt),
      health?.latestSweep?.completedAt,
    ].filter((value): value is string => Boolean(value));
    return timestamps.reduce((latest, value) => value > latest ? value : latest, "") || null;
  }, [comparison, health]);

  function leaderboardReturnHref() {
    const params = new URLSearchParams();
    if (selectedAssetIds.length) params.set("assets", selectedAssetIds.join(","));
    if (enabledProtocols.join(",") !== defaultProtocols.join(",")) params.set("protocols", enabledProtocols.join(","));
    if (executionMode !== "optimized") params.set("mode", executionMode);
    if (viewWindow !== "now") params.set("window", viewWindow);
    const query = params.toString();
    return `/${query ? `?${query}` : ""}#leaderboard-results`;
  }

  function analysisHref(route: Route, size: QuoteSize) {
    const params = new URLSearchParams({
      size: size.id,
      mode: executionMode,
      days: String(viewWindow === "now" ? trendDays : Number(viewWindow.slice(0, -1))),
      protocols: enabledProtocols.join(","),
      back: leaderboardReturnHref(),
    });
    return `/routes/${encodeURIComponent(route.id)}?${params}`;
  }

  function replaceAnalysisUrl(size: QuoteSize, days: TrendDays) {
    if (view !== "analysis" || !selectedRoute) return;
    const params = new URLSearchParams({
      size: size.id,
      mode: executionMode,
      days: String(days),
      protocols: enabledProtocols.join(","),
      back: initialQuery.back,
    });
    window.history.replaceState(null, "", `/routes/${encodeURIComponent(selectedRoute.id)}?${params}`);
  }

  function inspect(route: Route, size: QuoteSize) {
    window.history.replaceState(null, "", leaderboardReturnHref());
    window.location.assign(analysisHref(route, size));
  }

  function changeWindow(window: ViewWindow) {
    setViewWindow(window);
    if (window !== "now") setTrendDays(Number(window.slice(0, -1)) as TrendDays);
  }

  function changeAnalysisSize(size: QuoteSize) {
    setSelectedSize(size);
    replaceAnalysisUrl(size, trendDays);
  }

  function changeTrendDays(days: TrendDays) {
    setTrendDays(days);
    replaceAnalysisUrl(selectedSize, days);
  }

  function openLatestDetails() {
    auditRequest.current?.abort();
    auditRequest.current = null;
    setAuditRunId(null);
    setAuditDetails(null);
    setAuditLoading(false);
    setRequestsOpen(true);
  }

  function navigateRunDetails(runId: number) {
    if (runId === runDetails?.run?.id) {
      openLatestDetails();
      return;
    }
    auditRequest.current?.abort();
    const controller = new AbortController();
    auditRequest.current = controller;
    setAuditRunId(runId);
    setAuditDetails(null);
    setAuditLoading(true);
    setRequestsOpen(true);
    fetch(`/api/runs?${new URLSearchParams({ runId: String(runId) })}`, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        const data = await response.json() as RunResponse;
        if (!response.ok) throw new Error(data.error ?? "Historical quote details unavailable");
        if (!controller.signal.aborted) setAuditDetails(data);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setAuditDetails({ run: null, quotes: [], error: error instanceof Error ? error.message : "Historical quote details unavailable" });
      })
      .finally(() => {
        if (!controller.signal.aborted) setAuditLoading(false);
        if (auditRequest.current === controller) auditRequest.current = null;
      });
  }

  function closeRequestDrawer() {
    auditRequest.current?.abort();
    auditRequest.current = null;
    setAuditLoading(false);
    setRequestsOpen(false);
  }

  function toggleProtocol(id: PartnerId) {
    if (partners.find((partner) => partner.id === id)?.disabled) return;
    const next = enabledProtocols.includes(id)
      ? enabledProtocols.length <= 2 ? enabledProtocols : enabledProtocols.filter((protocol) => protocol !== id)
      : partners.filter((partner) => [...enabledProtocols, id].includes(partner.id)).map((partner) => partner.id);
    const selectedAssets = new Set(selectedAssetIds);
    const selectedProtocols = new Set(next);
    enabledProtocolsRef.current = next;
    setEnabledProtocols(next);
    setSelectedRoute((current) => current && routeMatchesAssets(current, selectedAssets) && routeMatchesProtocols(current, selectedProtocols)
      ? current
      : (catalog?.routes ?? []).find((route) => routeMatchesAssets(route, selectedAssets) && routeMatchesProtocols(route, selectedProtocols)) ?? null);
  }

  function toggleAsset(assetId: string) {
    const next = selectedAssetIds.includes(assetId)
      ? selectedAssetIds.length === 1 ? [] : selectedAssetIds.filter((item) => item !== assetId)
      : availableAssets.map((asset) => asset.id).filter((id) => id === assetId || selectedAssetIds.includes(id));
    const normalized = next.length === availableAssets.length ? [] : next;
    const selectedAssets = new Set(normalized);
    const selectedProtocols = new Set(enabledProtocols);
    selectedAssetIdsRef.current = normalized;
    setSelectedAssetIds(normalized);
    setSelectedRoute((current) => current && routeMatchesAssets(current, selectedAssets) && routeMatchesProtocols(current, selectedProtocols)
      ? current
      : (catalog?.routes ?? []).find((route) => routeMatchesAssets(route, selectedAssets) && routeMatchesProtocols(route, selectedProtocols)) ?? null);
  }

  function clearAssetFilters() {
    const selectedProtocols = new Set(enabledProtocols);
    selectedAssetIdsRef.current = [];
    setSelectedAssetIds([]);
    setSelectedRoute((current) => current && routeMatchesProtocols(current, selectedProtocols)
      ? current
      : (catalog?.routes ?? []).find((route) => routeMatchesProtocols(route, selectedProtocols)) ?? null);
  }

  function toggleTheme() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    window.localStorage.setItem("swaprank-theme", next);
  }

  function refreshPageData() {
    const requestedAt = Date.now();
    if (manualRefreshAvailableAt > requestedAt) return;
    lastRefreshRequestedAt.current = requestedAt;
    setManualRefreshAvailableAt(requestedAt + manualRefreshCooldownMs);
    setRefreshVersion((current) => current + 1);
  }

  const pageRefreshing = loading || comparisonLoading || runLoading || trendLoading;
  const refreshCoolingDown = manualRefreshAvailableAt > now;

  return <main className="app-shell" id="top">
    <header className="topbar">
      <Link className="brand" href="/" aria-label="SwapRank home"><span className="brand-symbol"><i /><i /><i /></span><span>Swap<span>Rank</span></span></Link>
      <div className="top-actions"><nav aria-label="Primary navigation">{view === "analysis" ? <><a href={initialQuery.back}>Leaderboard</a><a className="active" href="#analysis">Route analysis</a></> : <a className="active" href="#leaderboard">Leaderboard</a>}</nav><button className="theme-toggle" onClick={toggleTheme} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}><span className="theme-glyph" aria-hidden="true" /><b>{theme === "dark" ? "Light" : "Dark"}</b></button></div>
    </header>

    {view === "leaderboard" && <section className="route-section" id="leaderboard">
      <header className="page-heading">
        <div className="page-heading-main"><div><p className="eyebrow">Market data / leaderboard</p><h1>QUOTE LEADERBOARD</h1><p className="page-heading-description">Cross-chain DEX quotes compared by trade size.</p></div></div>
        <div className="latest-check"><div><span>LATEST CHECK</span><button className="refresh-button" type="button" onClick={refreshPageData} disabled={pageRefreshing || refreshCoolingDown} aria-label={refreshCoolingDown ? "Refresh available after cooldown" : "Refresh page data"}><i aria-hidden="true">↻</i><span>{pageRefreshing ? "Refreshing" : refreshCoolingDown ? "Cooldown" : "Refresh"}</span></button></div><strong>{latestCheckAt ? formatLocalTime(latestCheckAt) : "No completed check"}</strong><small aria-live="polite">{latestCheckAt ? formatAgeLabel(latestCheckAt, now) : "Waiting for first refresh"}</small></div>
      </header>

      <section className={`leaderboard-filter-panel ${mobileFiltersOpen ? "open" : ""}`}>
        <button className="leaderboard-filter-summary" type="button" onClick={() => setMobileFiltersOpen((current) => !current)} aria-expanded={mobileFiltersOpen} aria-controls="leaderboard-filters"><span><b>Ranking settings</b><small>{assetSummary} · {activePartners.length} protocols · {executionLabel(executionMode)} · {viewWindow === "now" ? "Latest" : viewWindow}</small></span><strong>Filters</strong></button>
        <div className="filter-bar leaderboard-tools" id="leaderboard-filters">
          <fieldset className="protocol-filter"><legend>Compare protocols</legend><div>{partners.map((partner) => <button key={partner.id} className={`${enabledProtocols.includes(partner.id) ? "selected" : ""} ${partner.disabled ? "disabled" : ""}`} onClick={() => toggleProtocol(partner.id)} aria-pressed={enabledProtocols.includes(partner.id)} disabled={Boolean(partner.disabled) || (enabledProtocols.length <= 2 && enabledProtocols.includes(partner.id))}><PartnerMark id={partner.id} muted={!enabledProtocols.includes(partner.id)} /><span>{partner.name}{partner.disabled ? " · DISABLED" : ""}</span></button>)}</div><small>Choose at least two. Maya is disabled while the protocol is halted.</small></fieldset>
          <fieldset className="asset-filter"><legend>Assets</legend><div className="asset-select" ref={assetMenu}>
            <button className="asset-select-trigger" type="button" onClick={() => setAssetMenuOpen((current) => !current)} aria-expanded={assetMenuOpen} aria-controls="asset-select-menu">
              <span className="asset-select-summary" ref={assetSummaryBox}>{selectedAssets.length === 0
                ? <span className="asset-summary-chip all">ALL</span>
                : <>{selectedAssets.slice(0, visibleAssetCount).map((asset) => <span className="asset-summary-chip" key={asset.id} title={`${asset.symbol} on ${chainLabel(asset.chain)}`}><b>{asset.symbol}</b>{ambiguousAssetSymbols.has(asset.symbol) && <small>{compactChainLabel(asset.chain)}</small>}</span>)}{selectedAssets.length > visibleAssetCount && <span className="asset-summary-more">+{selectedAssets.length - visibleAssetCount}</span>}</>}
              </span>
              <span className="asset-select-measure" ref={assetSummaryMeasure} aria-hidden="true">
                {selectedAssets.map((asset) => <span className="asset-summary-chip" data-asset-chip key={asset.id}><b>{asset.symbol}</b>{ambiguousAssetSymbols.has(asset.symbol) && <small>{compactChainLabel(asset.chain)}</small>}</span>)}
                {selectedAssets.map((_, index) => <span className="asset-summary-more" data-asset-more={selectedAssets.length - index} key={selectedAssets.length - index}>+{selectedAssets.length - index}</span>)}
              </span>
              <span className="asset-select-chevron" aria-hidden="true">⌄</span>
            </button>
            {assetMenuOpen && <div className="asset-select-menu" id="asset-select-menu" role="listbox" aria-multiselectable="true" aria-label="Filter routes by asset">
              <button className={`asset-select-option all ${selectedAssetIds.length === 0 ? "selected" : ""}`} type="button" role="option" aria-selected={selectedAssetIds.length === 0} onClick={clearAssetFilters}><span className="asset-checkbox" aria-hidden="true">{selectedAssetIds.length === 0 ? "✓" : ""}</span><span className="asset-option-copy"><b>ALL ASSETS</b><small>Show every supported route</small></span></button>
              {availableAssets.map((asset) => {
                const selected = selectedAssetIds.includes(asset.id);
                return <button className={`asset-select-option ${selected ? "selected" : ""}`} type="button" role="option" aria-selected={selected} key={asset.id} onClick={() => toggleAsset(asset.id)}><span className="asset-checkbox" aria-hidden="true">{selected ? "✓" : ""}</span><AssetMark asset={asset} /><span className="asset-option-copy"><b>{asset.symbol}</b><small>{chainLabel(asset.chain)}</small></span></button>;
              })}
              <div className="asset-select-footer">{filteredRoutes.length} of {catalog?.routes.length ?? 0} routes</div>
            </div>}
          </div></fieldset>
          <fieldset className="execution-filter"><legend>Execution mode</legend><div className="segmented"><button className={executionMode === "optimized" ? "selected" : ""} onClick={() => setExecutionMode("optimized")}>Streaming/DCA</button><button className={executionMode === "standard" ? "selected" : ""} onClick={() => setExecutionMode("standard")}>Standard swap</button></div></fieldset>
          <fieldset className="comparison-window-filter"><legend>Comparison window</legend><div className="segmented">{(["now", "7d", "14d", "30d"] as ViewWindow[]).map((window) => <button key={window} className={viewWindow === window ? "selected" : ""} onClick={() => changeWindow(window)}>{window === "now" ? "Latest check" : window.replace("d", " days")}</button>)}</div></fieldset>
        </div>
      </section>

      {catalog?.catalog?.status === "stale" && <div className="catalog-notice" role="status">
        <div><b>{catalog.catalog.source === "static" ? "LIVE CATALOG OFFLINE" : "SHOWING STORED ROUTES"}</b><span>{catalog.catalog.source === "static" ? "Historical results remain available from the fixed route list." : `Last successful catalog refresh: ${catalog.catalog.refreshedAt ? formatLocalTime(catalog.catalog.refreshedAt) : "unknown"}.`}</span></div>
        <strong>{health?.catalog?.collectionPaused ? "NEW CHECKS PAUSED" : "LIVE REFRESH DEGRADED"}</strong>
      </div>}

      {catalog?.error ? <div className="error-state"><b>Route catalog unavailable</b><span>{catalog.error}</span></div> : <div className={`leaderboard-wrap ${loading || comparisonLoading ? "loading" : ""}`}>
        <table className="leaderboard-table">
          <thead><tr><th>Route / asset pair</th>{quoteSizes.map((size) => <th key={size.id}>{size.label}</th>)}</tr></thead>
          <tbody>{filteredRoutes.map((route) => <tr key={route.id}>
            <th><button className="route-cell" onClick={() => inspect(route, selectedSize)}><LeaderboardRoutePath route={route} /><span className="coverage-dots">{partners.map((partner) => <PartnerMark key={partner.id} id={partner.id} muted={!route.partners.includes(partner.id) || !enabledProtocols.includes(partner.id)} />)}</span></button></th>
            {quoteSizes.map((size) => <td key={size.id}><button className="result-button" onClick={() => inspect(route, size)} aria-label={`Inspect ${route.source.symbol} to ${route.destination.symbol} at ${size.label}`}><ComparisonResult cell={cells.get(`${route.id}::${size.id}`)} window={viewWindow} now={now} /></button></td>)}
          </tr>)}</tbody>
        </table>
        <div className="mobile-route-list" id="leaderboard-results" aria-label="Mobile route leaderboard">
          <header className="mobile-leaderboard-header"><div><b>Ranked routes</b><small>Choose a trade size</small></div><div className="mobile-leaderboard-sizes" role="group" aria-label="Trade size for mobile leaderboard">{quoteSizes.map((size) => <button key={size.id} className={selectedSize.id === size.id ? "selected" : ""} onClick={() => setSelectedSize(size)} aria-pressed={selectedSize.id === size.id}>{size.label}</button>)}</div></header>
          {loading && <div className="mobile-route-loading" role="status">Loading ranked routes…</div>}
          {filteredRoutes.map((route) => <MobileRouteCard key={route.id} route={route} selectedSize={selectedSize} cells={cells} viewWindow={viewWindow} now={now} enabledProtocols={enabledProtocols} onInspect={inspect} />)}
        </div>
        {!loading && catalog?.routes.length === 0 && <div className="empty-table">No fixed routes are available.</div>}
        {!loading && Boolean(catalog?.routes.length) && filteredRoutes.length === 0 && <div className="empty-table">No routes match the selected assets and protocols.</div>}
      </div>}
    </section>}

    {view === "analysis" && <section className="route-detail" id="analysis">
      <a className="analysis-back-link" href={initialQuery.back}>← Back to leaderboard</a>
      <div className="detail-header compact">
        <div><p className="eyebrow">Route analysis · {executionLabel(executionMode)}</p>{selectedRoute ? <h2 className="detail-route"><RoutePair route={selectedRoute} /></h2> : <h2>{loading ? "Loading route…" : "Route unavailable"}</h2>}</div>
        {selectedRoute && <div className="detail-actions"><div className="coverage-summary"><span>Compared protocols</span><div>{partners.map((partner) => <PartnerMark key={partner.id} id={partner.id} muted={!selectedRoute.partners.includes(partner.id) || !enabledProtocols.includes(partner.id)} />)}</div></div></div>}
      </div>
      {!loading && !selectedRoute && <div className="error-state"><b>This route could not be found</b><span>It may no longer be in the supported route catalog. Return to the leaderboard to choose another route.</span></div>}
      {selectedRoute && <div className="route-telemetry" aria-label="Route telemetry">
        <span><b>ASSET PATH</b><code>{selectedRoute.source.thorAsset} → {selectedRoute.destination.thorAsset}</code></span>
        <span><b>QUOTE AGE</b><strong>{runDetails?.run ? formatAgeLabel(runDetails.run.initiatedAt, now) : runLoading ? "syncing" : "—"}</strong></span>
        <span><b>SYNC SKEW</b><strong>{runDetails?.run?.maxRequestSkewMs != null ? `${runDetails.run.maxRequestSkewMs} ms` : "—"}</strong></span>
      </div>}

      {selectedRoute && <LatestQuoteComparison route={selectedRoute} runDetails={runDetails} runLoading={runLoading} selectedSize={selectedSize} onOpenDetails={openLatestDetails} />}

      {selectedRoute && <div className="analysis-toolbar">
        <p className="mobile-toolbar-label">Trade size</p>
        <div className="size-selectors" role="group" aria-label="Exact USD input for route analysis">{quoteSizes.map((size) => <button key={size.id} className={selectedSize.id === size.id ? "selected" : ""} onClick={() => changeAnalysisSize(size)} aria-pressed={selectedSize.id === size.id}><strong>{size.label}</strong></button>)}</div>
      </div>}

      {selectedRoute && <div className="analysis-view-tabs" role="tablist" aria-label="Route analysis view">
        <button role="tab" aria-selected={analysisPanel === "performance"} className={analysisPanel === "performance" ? "selected" : ""} onClick={() => setAnalysisPanel("performance")}>Quote performance</button>
        <button role="tab" aria-selected={analysisPanel === "depth"} className={analysisPanel === "depth" ? "selected" : ""} onClick={() => setAnalysisPanel("depth")}>Depth + price</button>
      </div>}

      {selectedRoute && analysisPanel === "performance" && <section className="trend-card" aria-labelledby="trend-title">
        <header className="trend-header">
          <div><p className="eyebrow">Historical {executionLabel(executionMode)} deviation from THORChain oracle · {selectedSize.label}</p><h3 id="trend-title">{trendLeaderPartner && trend?.leader ? <>{trendLeaderPartner.name} won most quotes over {trendPeriodLabel(trendDays)}</> : <>Performance over {trendPeriodLabel(trendDays)}</>}</h3><p>{trend?.leader ? `${Math.round(trend.leader.winRate * 100)}% win share · ${formatBps(trend.leader.averageOracleGapBps)} average vs oracle · ${Math.round(trend.leader.availability * 100)}% quote availability · ${trend.comparableRuns} comparisons` : "A period leader appears after the first oracle-referenced quote batch."}</p></div>
          <div className="trend-controls">
            <fieldset><legend>Period</legend><div className="segmented light">{([1, 7, 14, 30] as const).map((days) => <button key={days} className={trendDays === days ? "selected" : ""} onClick={() => changeTrendDays(days)}>{days === 1 ? "Last 24 hours" : `${days}d`}</button>)}</div></fieldset>
          </div>
        </header>
        {trendLoading ? <div className="trend-empty"><b>Loading quote history…</b><span>Building the basis-point series for this route and size.</span></div> : trend ? <TrendChart data={trend} activePartners={activePartners} /> : <div className="trend-empty"><b>Trend unavailable</b><span>{trendError ?? "No historical quote data was returned."}</span></div>}
        <div className="trend-note"><b>0 bps is THORChain oracle parity</b><span>{trend?.pointMode === "comparison" ? "Every point compares the quoted output with the same synchronized CEX-derived oracle cross-rate. The highest point is the batch winner; points below zero return less than oracle parity and points above zero return more." : "Every point shows each DEX’s median signed deviation from the synchronized CEX-derived oracle within that time bucket. Winner share is still calculated from the highest quoted output in each batch."}</span></div>
      </section>}

      {selectedRoute && analysisPanel === "depth" && <DepthForecastCard route={selectedRoute} runDetails={runDetails} runLoading={runLoading} selectedSize={selectedSize} />}

      {requestsOpen && <div className="request-drawer-backdrop">
        <button className="request-drawer-dismiss" onClick={closeRequestDrawer} aria-label="Close quote details" />
        <aside className="request-drawer" role="dialog" aria-modal="true" aria-labelledby="request-drawer-title">
          <header><div><p className="eyebrow">Quote audit</p><h2 id="request-drawer-title">{selectedRoute ? `${selectedRoute.source.symbol} → ${selectedRoute.destination.symbol}` : "Quote details"}</h2></div><button onClick={closeRequestDrawer} aria-label="Close quote details">×</button></header>
          <RequestDetails runDetails={auditRunId == null ? runDetails : auditDetails} runLoading={auditRunId == null ? runLoading : auditLoading} selectedSize={selectedSize} historical={auditRunId != null} onNavigate={navigateRunDetails} />
        </aside>
      </div>}
    </section>}

    <footer><Link className="footer-brand" href="/"><span className="brand-symbol"><i /><i /><i /></span><b>SwapRank</b></Link><div className="footer-links">{view === "analysis" ? <a href={initialQuery.back}>← Leaderboard</a> : <a href="#top">Back to top ↑</a>}<a className="footer-github" href="https://github.com/gerritsa/DEXQuoteTool" target="_blank" rel="noreferrer" aria-label="View SwapRank on GitHub"><svg aria-hidden="true" viewBox="0 0 24 24"><path fill="currentColor" d="M12 .3a12 12 0 0 0-3.79 23.39c.6.11.82-.26.82-.58v-2.26c-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.74.08-.74 1.2.09 1.84 1.23 1.84 1.23 1.07 1.84 2.8 1.31 3.49 1 .11-.78.42-1.31.76-1.61-2.67-.3-5.47-1.34-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.12-.3-.54-1.52.12-3.17 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.65.24 2.87.12 3.17.77.84 1.24 1.91 1.24 3.22 0 4.6-2.8 5.62-5.48 5.92.43.37.81 1.1.81 2.22v3.28c0 .32.22.69.83.57A12 12 0 0 0 12 .3" /></svg><span>GitHub</span></a></div></footer>
  </main>;
}
