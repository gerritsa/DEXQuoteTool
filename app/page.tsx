"use client";
/* eslint-disable @next/next/no-img-element -- small static logos are served directly by the Worker */

import { useEffect, useMemo, useRef, useState } from "react";
import { quoteSizes, type QuoteSize } from "../lib/quotes/sizes";

type PartnerId = "thorchain" | "chainflip" | "near-intents" | "maya";
type ViewWindow = "now" | "7d" | "14d" | "30d";
type ExecutionMode = "standard" | "optimized";
type Theme = "dark" | "light";

const pageRefreshIntervalMs = 15 * 60_000;
const resumeRefreshThresholdMs = 60_000;

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
  averageEdgeBps?: number | null;
  winRate?: number | null;
  sampleCount?: number;
  availability?: number | null;
};

type TrendPoint = {
  protocol: PartnerId;
  edgeBps: number | null;
  sampleCount: number;
  winRate: number | null;
};

type TrendResponse = {
  days: number;
  bucketMs: number;
  startAt: string;
  endAt: string;
  comparableRuns: number;
  leader: null | { protocol: PartnerId; averageEdgeBps: number; medianEdgeBps: number; winRate: number; sampleCount: number; availability: number };
  summary: Array<{ protocol: PartnerId; averageEdgeBps: number | null; medianEdgeBps: number | null; winRate: number | null; sampleCount: number; availability: number }>;
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
  run: null | {
    initiatedAt: string;
    sourceAmountBaseUnits: string;
    sourceAmountUsd: number;
    sourcePriceUsd: number;
    mode: string;
    status: string;
    maxRequestSkewMs?: number | null;
  };
  quotes: Array<{
    id: number;
    protocol: PartnerId;
    strategy: string;
    status: string;
    errorCode?: string | null;
    expectedOutputFormatted?: string | null;
    expectedOutputBaseUnits?: string | null;
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

const partners: Array<{ id: PartnerId; name: string; cellName: string; color: string; logo: string; disabled?: boolean }> = [
  { id: "thorchain", name: "THORCHAIN", cellName: "THORCHAIN", color: "#17b897", logo: "/partners/thorchain.png" },
  { id: "maya", name: "MAYA PROTOCOL", cellName: "MAYA PROTOCOL", color: "#ef6a38", logo: "/partners/maya.svg", disabled: true },
  { id: "chainflip", name: "CHAINFLIP", cellName: "CHAINFLIP", color: "#ed49c9", logo: "/partners/chainflip.svg" },
  { id: "near-intents", name: "NEAR", cellName: "NEAR", color: "var(--near-series)", logo: "/partners/near.svg" },
];

function PartnerMark({ id, muted = false }: { id: PartnerId; muted?: boolean }) {
  const partner = partners.find((item) => item.id === id)!;
  return <span className={`partner-mark logo-${id} ${muted ? "muted" : ""}`} role="img" aria-label={partner.name} title={partner.name}><img src={partner.logo} alt="" /></span>;
}

function executionLabel(mode: ExecutionMode) {
  return mode === "standard" ? "Standard swap" : "Streaming/DCA";
}

function AssetMark({ asset }: { asset: Route["source"] }) {
  const symbol = asset.symbol.toLowerCase();
  return <span className="asset-mark" role="img" aria-label={`${asset.symbol} logo`}><img src={`/assets/${symbol}.png`} alt="" /></span>;
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

function formatTokenAmount(value?: string | number | null) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "—";
  const absolute = Math.abs(amount);
  const maximumFractionDigits = absolute >= 1_000 ? 2 : absolute >= 1 ? 4 : absolute >= 0.01 ? 6 : 8;
  return amount.toLocaleString([], { maximumFractionDigits });
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
    return <span className={`cell-result protocol-${cell.leader}`}><span><PartnerMark id={cell.leader} /><b>{partner.cellName}</b></span><strong>{Math.round((cell.winRate ?? 0) * 100)}% wins</strong><small>avg {formatBps(cell.averageEdgeBps)} vs median · {cell.sampleCount ?? 0} checks</small></span>;
  }
  const quoteCount = cell.successfulQuotes ?? 0;
  return <span className={`cell-result protocol-${cell.leader}`}><span><PartnerMark id={cell.leader} /><b>{cell.tie ? "Tie" : partner.cellName}</b></span><strong>{cell.marginBps == null ? "ONLY QUOTE" : cell.tie ? "Exact tie" : formatBps(cell.marginBps)}{cell.marginBps != null && cell.runnerUp && !cell.tie && <span className="margin-context">vs <PartnerMark id={cell.runnerUp} /></span>}</strong><small>{quoteCount} {quoteCount === 1 ? "quote" : "quotes"} · {formatAgeLabel(cell.capturedAt, now)}</small></span>;
}

function MobileRouteCard({ route, selectedSize, cells, viewWindow, now, activePartnerCount, onInspect }: {
  route: Route;
  selectedSize: QuoteSize;
  cells: Map<string, ComparisonCell>;
  viewWindow: ViewWindow;
  now: number;
  activePartnerCount: number;
  onInspect: (route: Route, size: QuoteSize) => void;
}) {
  const selectedCell = cells.get(`${route.id}::${selectedSize.id}`);
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
      <div className="mobile-route-coverage"><span>{activePartnerCount} protocols compared</span><div>{partners.map((partner) => <PartnerMark key={partner.id} id={partner.id} muted={!route.partners.includes(partner.id)} />)}</div></div>
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
            return <article key={quote.id} className={`latest-quote-card protocol-${quote.protocol} ${isWinner ? "winner" : ""}`}>
              <div><PartnerMark id={quote.protocol} /><b>{partners.find((partner) => partner.id === quote.protocol)?.cellName}</b>{isWinner && <em>Best</em>}</div>
              {isQuoted ? <strong>{formatTokenAmount(quote.expectedOutputFormatted)} <span>{route.destination.symbol}</span></strong> : <strong className="quote-unavailable">{quoteStatusLabel(quote)}</strong>}
              <small>{isWinner ? "Best output" : gapBps != null ? `${formatBps(gapBps)} vs best` : quote.errorCode ?? quote.status}{quote.responseLatencyMs != null ? ` · ${quote.responseLatencyMs} ms` : ""}</small>
            </article>;
          })}
        </div>
      </div>
    </> : <div className="latest-comparison-state"><b>{runDetails?.error ? "Latest comparison unavailable" : "No captured comparison yet"}</b><span>{runDetails?.error ? "Quote history could not be loaded. Raw details contain the diagnostic response." : `The next ${selectedSize.label} quote batch will appear here.`}</span></div>}
  </section>;
}

function RequestDetails({ runDetails, runLoading, selectedSize }: { runDetails: RunResponse | null; runLoading: boolean; selectedSize: QuoteSize }) {
  const winnerProtocol = [...(runDetails?.quotes ?? [])]
    .filter((quote) => quote.status === "quoted" && quote.expectedOutputFormatted)
    .sort((a, b) => Number(b.expectedOutputFormatted) - Number(a.expectedOutputFormatted))[0]?.protocol;
  const orderedQuotes = [...(runDetails?.quotes ?? [])].sort((a, b) => partners.findIndex((partner) => partner.id === a.protocol) - partners.findIndex((partner) => partner.id === b.protocol));

  return <div className={`request-panel ${runDetails?.quotes.length ? "has-quotes" : ""}`}>
    <p className="eyebrow">Latest synchronized quotes · {selectedSize.label}</p>
    {runLoading ? <><h3>Loading requests…</h3><p>Reading the latest synchronized batch from quote history.</p></> : runDetails?.run ? <>
      <h3>{runDetails.quotes.length} protocol results</h3>
      <p>Captured {formatTime(runDetails.run.initiatedAt)} · ${runDetails.run.sourceAmountUsd.toLocaleString()} exact input · synchronized within {runDetails.run.maxRequestSkewMs ?? "—"} ms</p>
      <div className="request-list">{orderedQuotes.map((quote) => <details key={quote.id}>
        <summary><PartnerMark id={quote.protocol} /><span><b>{partners.find((partner) => partner.id === quote.protocol)?.name}</b><small>{quote.protocol === "chainflip" && runDetails.run?.mode === "optimized" && quote.strategy === "regular" ? "regular fallback" : quote.strategy} · {quote.responseLatencyMs ?? "—"} ms</small></span><strong className={winnerProtocol === quote.protocol ? "winner" : ""}>{winnerProtocol === quote.protocol ? "Best output" : quoteStatusLabel(quote)}</strong></summary>
        <dl><div><dt>Requested</dt><dd>{formatTime(quote.requestStartedAt)}</dd></div><div><dt>HTTP status</dt><dd>{quote.responseHttpStatus ?? "—"}</dd></div><div><dt>Expected output</dt><dd>{quote.expectedOutputFormatted ?? quote.expectedOutputBaseUnits ?? "—"}</dd></div><div><dt>Quote expiry</dt><dd>{formatTime(quote.quoteExpiresAt ?? undefined)}</dd></div></dl>
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
    const value = point.edgeBps;
    return value == null ? [] : [{ timestamp: bucket.timestamp, value, point }];
  }));
  if (!plotted.length) return <div className="trend-empty"><b>No trend line yet</b><span>Run this exact route and size at least twice to start the chart.</span></div>;

  const gaps = plotted.map((point) => Math.max(0, -point.value)).sort((a, b) => a - b);
  const percentile = gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * 0.95))] ?? 5;
  const bound = Math.max(5, Math.ceil(Math.min(percentile * 1.15, 1_000) / 5) * 5);
  const start = new Date(data.startAt).getTime();
  const end = new Date(data.endAt).getTime();
  const x = (timestamp: number) => padding.left + ((timestamp - start) / Math.max(1, end - start)) * (width - padding.left - padding.right);
  const y = (value: number) => padding.top + (-Math.max(-bound, Math.min(0, value)) / bound) * (height - padding.top - padding.bottom);
  const ticks = [0, -bound / 4, -bound / 2, -(bound * 3) / 4, -bound];

  const series = activePartners.map((partner) => ({
    partner,
    points: data.buckets.flatMap((bucket) => {
      const point = bucket.points.find((item) => item.protocol === partner.id);
      const value = point?.edgeBps ?? null;
      return point && value != null ? [{ timestamp: bucket.timestamp, value, point }] : [];
    }),
  }));

  return <div className="trend-visual">
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${data.days}-day quote gap in basis points from the best synchronized quote`}>
      <text className="axis-title" x={padding.left} y="11">BPS FROM BEST</text>
      {ticks.map((value) => <g key={value}><line x1={padding.left} x2={width - padding.right} y1={y(value)} y2={y(value)} className={value === 0 ? "zero-line" : "grid-line"} /><text x={padding.left - 9} y={y(value) + 3} textAnchor="end">{Number.isInteger(value) ? value : value.toFixed(1)}</text></g>)}
      <text x={padding.left} y={height - 7}>{new Date(start).toLocaleDateString([], { month: "short", day: "numeric" })}</text>
      <text x={width - padding.right} y={height - 7} textAnchor="end">{new Date(end).toLocaleDateString([], { month: "short", day: "numeric" })}</text>
      {series.map(({ partner, points }) => {
        const segments: typeof points[] = [];
        for (const point of points) {
          const current = segments[segments.length - 1];
          if (!current || point.timestamp - current[current.length - 1].timestamp > data.bucketMs * 1.5) segments.push([point]);
          else current.push(point);
        }
        return <g key={partner.id}>{segments.map((segment, index) => <polyline key={index} points={segment.map((point) => `${x(point.timestamp)},${y(point.value)}`).join(" ")} fill="none" stroke={partner.color} strokeWidth="2.5" vectorEffect="non-scaling-stroke" />)}{points.map((point) => <circle key={point.timestamp} cx={x(point.timestamp)} cy={y(point.value)} r="3" fill={partner.color}><title>{partner.name} · {formatBps(point.value)} from best · {point.point.sampleCount} samples in bucket</title></circle>)}</g>;
      })}
    </svg>
    <div className="trend-legend">{activePartners.map((partner) => {
      const summary = data.summary.find((item) => item.protocol === partner.id);
      return <span key={partner.id}><i style={{ background: partner.color }} /><b>{partner.name}</b><small>{summary?.sampleCount ? `${Math.round((summary.winRate ?? 0) * 100)}% best · ${formatBps(summary.averageEdgeBps)} avg gap · ${Math.round(summary.availability * 100)}% availability` : "No data"}</small></span>;
    })}</div>
  </div>;
}

export default function Home() {
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [enabledProtocols, setEnabledProtocols] = useState<PartnerId[]>(() => partners.filter((partner) => !partner.disabled).map((partner) => partner.id));
  const [executionMode, setExecutionMode] = useState<ExecutionMode>("optimized");
  const [viewWindow, setViewWindow] = useState<ViewWindow>("now");
  const [comparison, setComparison] = useState<ComparisonResponse | null>(null);
  const [comparisonLoading, setComparisonLoading] = useState(true);
  const [selectedRoute, setSelectedRoute] = useState<Route | null>(null);
  const [selectedSize, setSelectedSize] = useState<QuoteSize>(quoteSizes[3]);
  const [runDetails, setRunDetails] = useState<RunResponse | null>(null);
  const [runLoading, setRunLoading] = useState(false);
  const [requestsOpen, setRequestsOpen] = useState(false);
  const [trendDays, setTrendDays] = useState<7 | 14 | 30>(7);
  const [trend, setTrend] = useState<TrendResponse | null>(null);
  const [trendLoading, setTrendLoading] = useState(false);
  const [trendError, setTrendError] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [theme, setTheme] = useState<Theme>("dark");
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const lastRefreshRequestedAt = useRef(0);
  const activePartners = useMemo(() => partners.filter((partner) => enabledProtocols.includes(partner.id)), [enabledProtocols]);
  const protocolParam = enabledProtocols.join(",");
  const freshParam = refreshVersion > 0 ? String(refreshVersion) : null;

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams();
        if (freshParam) params.set("refresh", freshParam);
        const response = await fetch(`/api/routes${params.size ? `?${params}` : ""}`, { signal: controller.signal, cache: "no-store" });
        const data = await response.json() as CatalogResponse;
        if (!response.ok) throw new Error(data.error ?? "Route catalog unavailable");
        setCatalog(data);
        setSelectedRoute((current) => current && data.routes.some((route) => route.id === current.id) ? current : data.routes[0] ?? null);
      } catch (error) {
        if (!controller.signal.aborted) setCatalog({ error: error instanceof Error ? error.message : "Route catalog unavailable" } as CatalogResponse);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 200);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [freshParam]);

  useEffect(() => {
    const params = new URLSearchParams();
    if (freshParam) params.set("refresh", freshParam);
    const refresh = () => fetch(`/api/health${params.size ? `?${params}` : ""}`, { cache: "no-store" })
      .then(async (response) => setHealth(await response.json() as HealthResponse))
      .catch(() => setHealth({ status: "unhealthy", checkedAt: new Date().toISOString(), latestSweep: null, minutesSinceTerminalSweep: null, error: "Health endpoint unavailable" }));
    refresh();
    const clockTimer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(clockTimer);
  }, [freshParam]);

  useEffect(() => {
    lastRefreshRequestedAt.current = Date.now();
    const refreshIfVisibleAndStale = () => {
      if (document.visibilityState !== "visible" || Date.now() - lastRefreshRequestedAt.current < resumeRefreshThresholdMs) return;
      lastRefreshRequestedAt.current = Date.now();
      setRefreshVersion(Math.floor(Date.now() / 60_000));
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
    const controller = new AbortController();
    Promise.resolve().then(() => { if (!controller.signal.aborted) setComparisonLoading(true); });
    const params = new URLSearchParams({ window: viewWindow, mode: executionMode, protocols: protocolParam });
    if (freshParam) params.set("refresh", freshParam);
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
  }, [executionMode, freshParam, protocolParam, viewWindow]);

  useEffect(() => {
    if (!selectedRoute) return;
    const controller = new AbortController();
    Promise.resolve().then(() => { if (!controller.signal.aborted) setRunLoading(true); });
    const params = new URLSearchParams({ routeId: selectedRoute.id, amountId: selectedSize.id, mode: executionMode });
    if (freshParam) params.set("refresh", freshParam);
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
  }, [executionMode, freshParam, selectedRoute, selectedSize.id]);

  useEffect(() => {
    if (!selectedRoute) return;
    const controller = new AbortController();
    Promise.resolve().then(() => { if (!controller.signal.aborted) { setTrendLoading(true); setTrendError(null); } });
    const params = new URLSearchParams({ routeId: selectedRoute.id, amountId: selectedSize.id, mode: executionMode, days: String(trendDays), protocols: protocolParam, v: "3" });
    if (freshParam) params.set("refresh", freshParam);
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
  }, [executionMode, freshParam, protocolParam, selectedRoute, selectedSize.id, trendDays]);

  useEffect(() => {
    const saved = window.localStorage.getItem("swaprank-theme");
    const initial = saved === "light" ? "light" : "dark";
    document.documentElement.dataset.theme = initial;
    Promise.resolve().then(() => setTheme(initial));
  }, []);

  useEffect(() => {
    if (!requestsOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setRequestsOpen(false); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [requestsOpen]);

  const cells = useMemo(() => new Map((comparison?.cells ?? []).map((cell) => [`${cell.pairId}::${cell.amountId}`, cell])), [comparison]);
  const trendLeaderPartner = partners.find((partner) => partner.id === trend?.leader?.protocol);
  const latestCheckAt = useMemo(() => {
    const timestamps = [
      ...(comparison?.cells ?? []).map((cell) => cell.capturedAt),
      health?.latestSweep?.completedAt,
    ].filter((value): value is string => Boolean(value));
    return timestamps.reduce((latest, value) => value > latest ? value : latest, "") || null;
  }, [comparison, health]);

  function inspect(route: Route, size: QuoteSize) {
    setSelectedRoute(route);
    setSelectedSize(size);
    if (viewWindow !== "now") setTrendDays(Number(viewWindow.slice(0, -1)) as 7 | 14 | 30);
    setRequestsOpen(false);
    window.requestAnimationFrame(() => document.getElementById("analysis")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  function changeWindow(window: ViewWindow) {
    setViewWindow(window);
    if (window !== "now") setTrendDays(Number(window.slice(0, -1)) as 7 | 14 | 30);
  }

  function toggleProtocol(id: PartnerId) {
    setEnabledProtocols((current) => {
      if (partners.find((partner) => partner.id === id)?.disabled) return current;
      if (current.includes(id)) {
        return current.length <= 2 ? current : current.filter((protocol) => protocol !== id);
      }
      return partners.filter((partner) => [...current, id].includes(partner.id)).map((partner) => partner.id);
    });
  }

  function toggleTheme() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    window.localStorage.setItem("swaprank-theme", next);
  }

  function refreshPageData() {
    lastRefreshRequestedAt.current = Date.now();
    setRefreshVersion(Math.floor(Date.now() / 60_000));
  }

  const pageRefreshing = loading || comparisonLoading || runLoading || trendLoading;

  return <main className="app-shell" id="top">
    <header className="topbar">
      <a className="brand" href="#top" aria-label="SwapRank home"><span className="brand-symbol"><i /><i /><i /></span><span>Swap<span>Rank</span></span></a>
      <div className="top-actions"><nav aria-label="Primary navigation"><a className="active" href="#leaderboard">Leaderboard</a><a href="#analysis">Route analysis</a></nav><button className="theme-toggle" onClick={toggleTheme} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}><span className="theme-glyph" aria-hidden="true" /><b>{theme === "dark" ? "Light" : "Dark"}</b></button></div>
    </header>

    <section className="route-section" id="leaderboard">
      <header className="page-heading">
        <div className="page-heading-main"><div><p className="eyebrow">Market data / leaderboard</p><h1>QUOTE LEADERBOARD</h1><p className="page-heading-description">Cross-chain DEX quotes compared by trade size.</p></div></div>
        <div className="latest-check"><div><span>LATEST CHECK</span><button className="refresh-button" type="button" onClick={refreshPageData} disabled={pageRefreshing} aria-label="Refresh page data"><i aria-hidden="true">↻</i><span>{pageRefreshing ? "Refreshing" : "Refresh"}</span></button></div><strong>{latestCheckAt ? formatLocalTime(latestCheckAt) : "No completed check"}</strong><small aria-live="polite">{latestCheckAt ? formatAgeLabel(latestCheckAt, now) : "Waiting for first refresh"}</small></div>
      </header>

      <section className={`leaderboard-filter-panel ${mobileFiltersOpen ? "open" : ""}`}>
        <button className="leaderboard-filter-summary" type="button" onClick={() => setMobileFiltersOpen((current) => !current)} aria-expanded={mobileFiltersOpen} aria-controls="leaderboard-filters"><span><b>Ranking settings</b><small>{activePartners.length} protocols · {executionLabel(executionMode)} · {viewWindow === "now" ? "Latest" : viewWindow}</small></span><strong>Filters</strong></button>
        <div className="filter-bar leaderboard-tools" id="leaderboard-filters">
          <fieldset className="protocol-filter"><legend>Compare protocols</legend><div>{partners.map((partner) => <button key={partner.id} className={`${enabledProtocols.includes(partner.id) ? "selected" : ""} ${partner.disabled ? "disabled" : ""}`} onClick={() => toggleProtocol(partner.id)} aria-pressed={enabledProtocols.includes(partner.id)} disabled={Boolean(partner.disabled) || (enabledProtocols.length <= 2 && enabledProtocols.includes(partner.id))}><PartnerMark id={partner.id} muted={!enabledProtocols.includes(partner.id)} /><span>{partner.name}{partner.disabled ? " · DISABLED" : ""}</span></button>)}</div><small>Choose at least two. Maya is disabled while the protocol is halted.</small></fieldset>
          <fieldset><legend>Execution mode</legend><div className="segmented"><button className={executionMode === "optimized" ? "selected" : ""} onClick={() => setExecutionMode("optimized")}>Streaming/DCA</button><button className={executionMode === "standard" ? "selected" : ""} onClick={() => setExecutionMode("standard")}>Standard swap</button></div></fieldset>
          <fieldset><legend>Comparison window</legend><div className="segmented">{(["now", "7d", "14d", "30d"] as ViewWindow[]).map((window) => <button key={window} className={viewWindow === window ? "selected" : ""} onClick={() => changeWindow(window)}>{window === "now" ? "Latest check" : window.replace("d", " days")}</button>)}</div></fieldset>
        </div>
      </section>

      {catalog?.catalog?.status === "stale" && <div className="catalog-notice" role="status">
        <div><b>{catalog.catalog.source === "static" ? "LIVE CATALOG OFFLINE" : "SHOWING STORED ROUTES"}</b><span>{catalog.catalog.source === "static" ? "Historical results remain available from the fixed route list." : `Last successful catalog refresh: ${catalog.catalog.refreshedAt ? formatLocalTime(catalog.catalog.refreshedAt) : "unknown"}.`}</span></div>
        <strong>{health?.catalog?.collectionPaused ? "NEW CHECKS PAUSED" : "LIVE REFRESH DEGRADED"}</strong>
      </div>}

      {catalog?.error ? <div className="error-state"><b>Route catalog unavailable</b><span>{catalog.error}</span></div> : <div className={`leaderboard-wrap ${loading || comparisonLoading ? "loading" : ""}`}>
        <table className="leaderboard-table">
          <thead><tr><th>Route / asset pair</th>{quoteSizes.map((size) => <th key={size.id}>{size.label}</th>)}</tr></thead>
          <tbody>{(catalog?.routes ?? []).map((route) => <tr key={route.id}>
            <th><button className="route-cell" onClick={() => inspect(route, selectedSize)}><LeaderboardRoutePath route={route} /><span className="coverage-dots">{partners.map((partner) => <PartnerMark key={partner.id} id={partner.id} muted={!route.partners.includes(partner.id) || !enabledProtocols.includes(partner.id)} />)}</span></button></th>
            {quoteSizes.map((size) => <td key={size.id}><button className="result-button" onClick={() => inspect(route, size)} aria-label={`Inspect ${route.source.symbol} to ${route.destination.symbol} at ${size.label}`}><ComparisonResult cell={cells.get(`${route.id}::${size.id}`)} window={viewWindow} now={now} /></button></td>)}
          </tr>)}</tbody>
        </table>
        <div className="mobile-route-list" id="leaderboard-results" aria-label="Mobile route leaderboard">
          <header className="mobile-leaderboard-header"><div><b>Ranked routes</b><small>Choose a trade size</small></div><div className="mobile-leaderboard-sizes" role="group" aria-label="Trade size for mobile leaderboard">{quoteSizes.map((size) => <button key={size.id} className={selectedSize.id === size.id ? "selected" : ""} onClick={() => setSelectedSize(size)} aria-pressed={selectedSize.id === size.id}>{size.label}</button>)}</div></header>
          {loading && <div className="mobile-route-loading" role="status">Loading ranked routes…</div>}
          {(catalog?.routes ?? []).map((route) => <MobileRouteCard key={route.id} route={route} selectedSize={selectedSize} cells={cells} viewWindow={viewWindow} now={now} activePartnerCount={activePartners.length} onInspect={inspect} />)}
        </div>
        {!loading && catalog?.routes.length === 0 && <div className="empty-table">No fixed routes are available.</div>}
      </div>}
    </section>

    <section className="route-detail" id="analysis">
      <a className="mobile-back-link" href="#leaderboard-results">← Back to ranked routes</a>
      <div className="detail-header compact">
        <div><p className="eyebrow">Route analysis · {executionLabel(executionMode)}</p>{selectedRoute ? <h2 className="detail-route"><RoutePair route={selectedRoute} /></h2> : <h2>Select a route</h2>}</div>
        {selectedRoute && <div className="detail-actions"><div className="coverage-summary"><span>Compared protocols</span><div>{partners.map((partner) => <PartnerMark key={partner.id} id={partner.id} muted={!selectedRoute.partners.includes(partner.id) || !enabledProtocols.includes(partner.id)} />)}</div></div></div>}
      </div>
      {selectedRoute && <div className="route-telemetry" aria-label="Route telemetry">
        <span><b>ASSET PATH</b><code>{selectedRoute.source.thorAsset} → {selectedRoute.destination.thorAsset}</code></span>
        <span><b>QUOTE AGE</b><strong>{runDetails?.run ? formatAgeLabel(runDetails.run.initiatedAt, now) : runLoading ? "syncing" : "—"}</strong></span>
        <span><b>SYNC SKEW</b><strong>{runDetails?.run?.maxRequestSkewMs != null ? `${runDetails.run.maxRequestSkewMs} ms` : "—"}</strong></span>
      </div>}

      {selectedRoute && <LatestQuoteComparison route={selectedRoute} runDetails={runDetails} runLoading={runLoading} selectedSize={selectedSize} onOpenDetails={() => setRequestsOpen(true)} />}

      <div className="analysis-toolbar">
        <p className="mobile-toolbar-label">Trade size</p>
        <div className="size-selectors" role="group" aria-label="Exact USD input for route analysis">{quoteSizes.map((size) => <button key={size.id} className={selectedSize.id === size.id ? "selected" : ""} onClick={() => setSelectedSize(size)} aria-pressed={selectedSize.id === size.id}><strong>{size.label}</strong></button>)}</div>
      </div>

      <section className="trend-card" aria-labelledby="trend-title">
        <header className="trend-header">
          <div><p className="eyebrow">Historical {executionLabel(executionMode)} gap to best · {selectedSize.label}</p><h3 id="trend-title">{trendLeaderPartner && trend?.leader ? <>{trendLeaderPartner.name} won most quotes over {trendDays} days</> : <>Performance over {trendDays} days</>}</h3><p>{trend?.leader ? `${Math.round(trend.leader.winRate * 100)}% best-quote share · ${formatBps(trend.leader.averageEdgeBps)} average gap · ${Math.round(trend.leader.availability * 100)}% quote availability · ${trend.comparableRuns} comparisons` : "A period leader appears after the first comparable quote batch."}</p></div>
          <div className="trend-controls">
            <fieldset><legend>Period</legend><div className="segmented light">{([7, 14, 30] as const).map((days) => <button key={days} className={trendDays === days ? "selected" : ""} onClick={() => setTrendDays(days)}>{days}d</button>)}</div></fieldset>
          </div>
        </header>
        {trendLoading ? <div className="trend-empty"><b>Loading quote history…</b><span>Building the basis-point series for this route and size.</span></div> : trend ? <TrendChart data={trend} activePartners={activePartners} /> : <div className="trend-empty"><b>Trend unavailable</b><span>{trendError ?? "No historical quote data was returned."}</span></div>}
        <div className="trend-note"><b>0 bps is the batch best</b><span>Each synchronized batch sets its highest output to zero; lower quotes show their shortfall, and exact ties split it equally. Each chart point shows the median gap within that time bucket.</span></div>
      </section>

      {requestsOpen && <div className="request-drawer-backdrop">
        <button className="request-drawer-dismiss" onClick={() => setRequestsOpen(false)} aria-label="Close latest quotes" />
        <aside className="request-drawer" role="dialog" aria-modal="true" aria-labelledby="request-drawer-title">
          <header><div><p className="eyebrow">Quote audit</p><h2 id="request-drawer-title">{selectedRoute ? `${selectedRoute.source.symbol} → ${selectedRoute.destination.symbol}` : "Latest quotes"}</h2></div><button onClick={() => setRequestsOpen(false)} aria-label="Close latest quotes">×</button></header>
          <RequestDetails runDetails={runDetails} runLoading={runLoading} selectedSize={selectedSize} />
        </aside>
      </div>}
    </section>

    <footer><a className="footer-brand" href="#top"><span className="brand-symbol"><i /><i /><i /></span><b>SwapRank</b></a><a href="#top">Back to top ↑</a></footer>
  </main>;
}
