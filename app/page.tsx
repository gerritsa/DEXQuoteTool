"use client";

import { useEffect, useMemo, useState } from "react";
import { quoteSizes, type QuoteSize } from "../lib/quotes/sizes";

type PartnerId = "thorchain" | "chainflip" | "near-intents" | "maya";
type ViewWindow = "now" | "7d" | "14d" | "30d";
type ExecutionMode = "standard" | "optimized";

type Route = {
  id: string;
  source: { id: string; label: string; chain: string; symbol: string; thorAsset: string };
  destination: { id: string; label: string; chain: string; symbol: string; thorAsset: string };
  partners: PartnerId[];
};

type CatalogResponse = {
  generatedAt: string;
  statuses: Record<PartnerId, { available: boolean; error?: string }>;
  counts: { filteredRoutes: number; scheduledRoutes: number };
  routes: Route[];
  routeSet?: { id: string; selectedAt: string; metric: string; description: string };
  error?: string;
};

type ComparisonCell = {
  pairId: string;
  amountId: string;
  capturedAt?: string;
  leader: PartnerId | null;
  marginBps?: number | null;
  tie?: boolean;
  successfulQuotes?: number;
  averageEdgeBps?: number | null;
  winRate?: number | null;
  sampleCount?: number;
  availability?: number | null;
  coverageQualified?: boolean;
};

type TrendPoint = {
  protocol: PartnerId;
  edgeBps: number | null;
  vsThorBps: number | null;
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
  buckets: Array<{ timestamp: number; winner: PartnerId | null; points: TrendPoint[] }>;
  error?: string;
};

type ComparisonResponse = {
  window: ViewWindow;
  cells: ComparisonCell[];
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

const partners: Array<{ id: PartnerId; name: string; cellName: string; color: string; logo: string }> = [
  { id: "thorchain", name: "THORCHAIN", cellName: "THORCHAIN", color: "#17b897", logo: "/partners/thorchain.png" },
  { id: "maya", name: "MAYA PROTOCOL", cellName: "MAYA PROTOCOL", color: "#ef6a38", logo: "/partners/maya.svg" },
  { id: "chainflip", name: "CHAINFLIP", cellName: "CHAINFLIP", color: "#ed49c9", logo: "/partners/chainflip.svg" },
  { id: "near-intents", name: "NEAR", cellName: "NEAR", color: "#171817", logo: "/partners/near.svg" },
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

function formatTime(value?: string) {
  if (!value) return "—";
  return new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatBps(value?: number | null) {
  if (value == null || !Number.isFinite(value)) return "—";
  const precision = Math.abs(value) < 10 ? 1 : 0;
  return `${value > 0 ? "+" : ""}${value.toFixed(precision)} bps`;
}

function ComparisonResult({ cell, window }: { cell?: ComparisonCell; window: ViewWindow }) {
  if (!cell?.leader) return <span className="cell-empty"><b>—</b><small>{cell?.sampleCount ? "Low coverage" : "No run"}</small></span>;
  const partner = partners.find((item) => item.id === cell.leader)!;
  if (window !== "now") {
    return <span className={`cell-result protocol-${cell.leader}`}><span><PartnerMark id={cell.leader} /><b>{partner.cellName}</b></span><strong>{formatBps(cell.averageEdgeBps)}</strong><small>{Math.round((cell.winRate ?? 0) * 100)}% wins · {cell.sampleCount ?? 0} checks</small></span>;
  }
  return <span className={`cell-result protocol-${cell.leader}`}><span><PartnerMark id={cell.leader} /><b>{cell.tie ? "Tie" : partner.cellName}</b></span><strong>{cell.marginBps == null ? "Only quote" : cell.tie ? "≤ 2 bps" : formatBps(cell.marginBps)}</strong><small>{cell.successfulQuotes ?? 0} valid quotes</small></span>;
}

function RequestDetails({ runDetails, runLoading, selectedSize }: { runDetails: RunResponse | null; runLoading: boolean; selectedSize: QuoteSize }) {
  const winnerProtocol = [...(runDetails?.quotes ?? [])]
    .filter((quote) => quote.status === "quoted" && quote.expectedOutputFormatted)
    .sort((a, b) => Number(b.expectedOutputFormatted) - Number(a.expectedOutputFormatted))[0]?.protocol;
  const orderedQuotes = [...(runDetails?.quotes ?? [])].sort((a, b) => partners.findIndex((partner) => partner.id === a.protocol) - partners.findIndex((partner) => partner.id === b.protocol));

  return <div className={`request-panel ${runDetails?.quotes.length ? "has-quotes" : ""}`}>
    <p className="eyebrow">Latest synchronized requests · {selectedSize.label}</p>
    {runLoading ? <><h3>Loading requests…</h3><p>Reading the latest synchronized batch from quote history.</p></> : runDetails?.run ? <>
      <h3>{runDetails.quotes.length} protocol results</h3>
      <p>Captured {formatTime(runDetails.run.initiatedAt)} · ${runDetails.run.sourceAmountUsd.toLocaleString()} exact input · synchronized within {runDetails.run.maxRequestSkewMs ?? "—"} ms</p>
      <div className="request-list">{orderedQuotes.map((quote) => <details key={quote.id}>
        <summary><PartnerMark id={quote.protocol} /><span><b>{partners.find((partner) => partner.id === quote.protocol)?.name}</b><small>{quote.strategy} · {quote.responseLatencyMs ?? "—"} ms</small></span><strong className={winnerProtocol === quote.protocol ? "winner" : ""}>{winnerProtocol === quote.protocol ? "Best output" : quote.status}</strong></summary>
        <dl><div><dt>Requested</dt><dd>{formatTime(quote.requestStartedAt)}</dd></div><div><dt>HTTP status</dt><dd>{quote.responseHttpStatus ?? "—"}</dd></div><div><dt>Expected output</dt><dd>{quote.expectedOutputFormatted ?? quote.expectedOutputBaseUnits ?? "—"}</dd></div><div><dt>Quote expiry</dt><dd>{formatTime(quote.quoteExpiresAt ?? undefined)}</dd></div></dl>
        <span className="json-label">Request</span><pre>{quote.requestPayloadJson ?? quote.requestUrl ?? "No request payload stored"}</pre><span className="json-label">Response</span><pre>{quote.rawResponseJson ?? quote.errorMessage ?? "No response payload stored"}</pre>
      </details>)}</div>
    </> : <><h3>No captured requests yet</h3><p>{runDetails?.error ?? "The latest scheduled sweep for this route, size, and execution mode will appear here when available."}</p><dl><div><dt>Request timestamp</dt><dd>—</dd></div><div><dt>Exact input amount</dt><dd>{selectedSize.label}</dd></div><div><dt>Raw request / response</dt><dd>Available after collection</dd></div></dl></>}
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

  const absolute = plotted.map((point) => Math.abs(point.value)).sort((a, b) => a - b);
  const percentile = absolute[Math.min(absolute.length - 1, Math.floor(absolute.length * 0.95))] ?? 5;
  const bound = Math.max(5, Math.ceil(Math.min(percentile * 1.15, 1_000) / 5) * 5);
  const start = new Date(data.startAt).getTime();
  const end = new Date(data.endAt).getTime();
  const x = (timestamp: number) => padding.left + ((timestamp - start) / Math.max(1, end - start)) * (width - padding.left - padding.right);
  const y = (value: number) => padding.top + ((bound - Math.max(-bound, Math.min(bound, value))) / (bound * 2)) * (height - padding.top - padding.bottom);

  const series = activePartners.map((partner) => ({
    partner,
    points: data.buckets.flatMap((bucket) => {
      const point = bucket.points.find((item) => item.protocol === partner.id);
      const value = point?.edgeBps ?? null;
      return point && value != null ? [{ timestamp: bucket.timestamp, value, point }] : [];
    }),
  }));

  return <div className="trend-visual">
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${data.days}-day quote edge in basis points versus the synchronized batch median`}>
      {[bound, bound / 2, 0, -bound / 2, -bound].map((value) => <g key={value}><line x1={padding.left} x2={width - padding.right} y1={y(value)} y2={y(value)} className={value === 0 ? "zero-line" : "grid-line"} /><text x={padding.left - 9} y={y(value) + 3} textAnchor="end">{value > 0 ? "+" : ""}{Math.round(value)}</text></g>)}
      <text x={padding.left} y={height - 7}>{new Date(start).toLocaleDateString([], { month: "short", day: "numeric" })}</text>
      <text x={width - padding.right} y={height - 7} textAnchor="end">{new Date(end).toLocaleDateString([], { month: "short", day: "numeric" })}</text>
      {series.map(({ partner, points }) => {
        const segments: typeof points[] = [];
        for (const point of points) {
          const current = segments[segments.length - 1];
          if (!current || point.timestamp - current[current.length - 1].timestamp > data.bucketMs * 1.5) segments.push([point]);
          else current.push(point);
        }
        return <g key={partner.id}>{segments.map((segment, index) => <polyline key={index} points={segment.map((point) => `${x(point.timestamp)},${y(point.value)}`).join(" ")} fill="none" stroke={partner.color} strokeWidth="2.5" vectorEffect="non-scaling-stroke" />)}{points.map((point) => <circle key={point.timestamp} cx={x(point.timestamp)} cy={y(point.value)} r="3" fill={partner.color}><title>{partner.name} · {formatBps(point.value)} · {point.point.sampleCount} samples in bucket</title></circle>)}</g>;
      })}
    </svg>
    <div className="trend-legend">{activePartners.map((partner) => {
      const summary = data.summary.find((item) => item.protocol === partner.id);
      return <span key={partner.id}><i style={{ background: partner.color }} /><b>{partner.name}</b><small>{summary?.sampleCount ? `${formatBps(summary.averageEdgeBps)} avg · ${Math.round(summary.availability * 100)}% coverage` : "No data"}</small></span>;
    })}</div>
  </div>;
}

export default function Home() {
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [enabledProtocols, setEnabledProtocols] = useState<PartnerId[]>(() => partners.map((partner) => partner.id));
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
  const activePartners = useMemo(() => partners.filter((partner) => enabledProtocols.includes(partner.id)), [enabledProtocols]);
  const protocolParam = enabledProtocols.join(",");

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      try {
        const response = await fetch("/api/routes", { signal: controller.signal });
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
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    Promise.resolve().then(() => { if (!controller.signal.aborted) setComparisonLoading(true); });
    fetch(`/api/comparison?${new URLSearchParams({ window: viewWindow, mode: executionMode, protocols: protocolParam })}`, { signal: controller.signal })
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
  }, [executionMode, protocolParam, viewWindow]);

  useEffect(() => {
    if (!selectedRoute) return;
    const controller = new AbortController();
    Promise.resolve().then(() => { if (!controller.signal.aborted) setRunLoading(true); });
    const params = new URLSearchParams({ routeId: selectedRoute.id, amountId: selectedSize.id, mode: executionMode });
    fetch(`/api/runs?${params}`, { signal: controller.signal })
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
  }, [executionMode, selectedRoute, selectedSize.id]);

  useEffect(() => {
    if (!selectedRoute) return;
    const controller = new AbortController();
    Promise.resolve().then(() => { if (!controller.signal.aborted) { setTrendLoading(true); setTrendError(null); } });
    const params = new URLSearchParams({ routeId: selectedRoute.id, amountId: selectedSize.id, mode: executionMode, days: String(trendDays), protocols: protocolParam });
    fetch(`/api/trends?${params}`, { signal: controller.signal })
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
  }, [executionMode, protocolParam, selectedRoute, selectedSize.id, trendDays]);

  useEffect(() => {
    if (!requestsOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setRequestsOpen(false); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [requestsOpen]);

  const cells = useMemo(() => new Map((comparison?.cells ?? []).map((cell) => [`${cell.pairId}::${cell.amountId}`, cell])), [comparison]);
  const trendLeaderPartner = partners.find((partner) => partner.id === trend?.leader?.protocol);

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
      if (current.includes(id)) {
        return current.length <= 2 ? current : current.filter((protocol) => protocol !== id);
      }
      return partners.filter((partner) => [...current, id].includes(partner.id)).map((partner) => partner.id);
    });
  }

  return <main className="app-shell" id="top">
    <header className="topbar">
      <a className="brand" href="#top"><span className="brand-symbol"><i /><i /><i /></span><span>DEX Quote <span>Tool</span></span></a>
      <nav aria-label="Primary navigation"><a className="active" href="#leaderboard">Leaderboard</a><a href="#analysis">Route analysis</a></nav>
    </header>

    <section className="route-section" id="leaderboard">
      <div className="leaderboard-intro"><p className="eyebrow">Quote leaderboard</p><h2>Best protocol by size</h2></div>

      <div className="filter-bar leaderboard-tools">
        <fieldset className="protocol-filter"><legend>Compare protocols</legend><div>{partners.map((partner) => <button key={partner.id} className={enabledProtocols.includes(partner.id) ? "selected" : ""} onClick={() => toggleProtocol(partner.id)} aria-pressed={enabledProtocols.includes(partner.id)} disabled={enabledProtocols.length <= 2 && enabledProtocols.includes(partner.id)}><PartnerMark id={partner.id} muted={!enabledProtocols.includes(partner.id)} /><span>{partner.name}</span></button>)}</div><small>Choose at least two. Results recalculate using only enabled protocols.</small></fieldset>
        <fieldset><legend>Execution mode</legend><div className="segmented"><button className={executionMode === "optimized" ? "selected" : ""} onClick={() => setExecutionMode("optimized")}>Streaming/DCA</button><button className={executionMode === "standard" ? "selected" : ""} onClick={() => setExecutionMode("standard")}>Standard swap</button></div></fieldset>
        <fieldset><legend>Comparison window</legend><div className="segmented">{(["now", "7d", "14d", "30d"] as ViewWindow[]).map((window) => <button key={window} className={viewWindow === window ? "selected" : ""} onClick={() => changeWindow(window)}>{window === "now" ? "Now" : window.replace("d", " days")}</button>)}</div></fieldset>
      </div>

      {catalog?.error ? <div className="error-state"><b>Route catalog unavailable</b><span>{catalog.error}</span></div> : <div className={`leaderboard-wrap ${loading || comparisonLoading ? "loading" : ""}`}>
        <table className="leaderboard-table">
          <thead><tr><th>Directed route</th>{quoteSizes.map((size) => <th key={size.id}>{size.label}</th>)}</tr></thead>
          <tbody>{(catalog?.routes ?? []).map((route, index) => <tr key={route.id}>
            <th><button className="route-cell" onClick={() => inspect(route, selectedSize)}><small>{String(index + 1).padStart(2, "0")}</small><RoutePair route={route} /><span className="coverage-dots">{partners.map((partner) => <PartnerMark key={partner.id} id={partner.id} muted={!route.partners.includes(partner.id) || !enabledProtocols.includes(partner.id)} />)}</span></button></th>
            {quoteSizes.map((size) => <td key={size.id}><button className="result-button" onClick={() => inspect(route, size)} aria-label={`Inspect ${route.source.symbol} to ${route.destination.symbol} at ${size.label}`}><ComparisonResult cell={cells.get(`${route.id}::${size.id}`)} window={viewWindow} /></button></td>)}
          </tr>)}</tbody>
        </table>
        {!loading && catalog?.routes.length === 0 && <div className="empty-table">No fixed routes are available.</div>}
      </div>}
    </section>

    <section className="route-detail" id="analysis">
      <div className="detail-header compact">
        <div><p className="eyebrow">Route analysis · {executionLabel(executionMode)}</p>{selectedRoute ? <h2 className="detail-route"><RoutePair route={selectedRoute} /></h2> : <h2>Select a route</h2>}</div>
        {selectedRoute && <div className="detail-actions"><div className="coverage-summary"><span>Compared protocols</span><div>{partners.map((partner) => <PartnerMark key={partner.id} id={partner.id} muted={!selectedRoute.partners.includes(partner.id) || !enabledProtocols.includes(partner.id)} />)}</div></div></div>}
      </div>

      <div className="analysis-toolbar">
        <div className="size-selectors" role="group" aria-label="Exact USD input for route analysis">{quoteSizes.map((size) => <button key={size.id} className={selectedSize.id === size.id ? "selected" : ""} onClick={() => setSelectedSize(size)} aria-pressed={selectedSize.id === size.id}><strong>{size.label}</strong><small>Exact input</small></button>)}</div>
        <button className="latest-request-button" onClick={() => setRequestsOpen(true)}><span>Latest requests</span><b>{runLoading ? "Loading…" : runDetails?.run ? formatTime(runDetails.run.initiatedAt) : "No batch yet"}</b></button>
      </div>

      <section className="trend-card" aria-labelledby="trend-title">
        <header className="trend-header">
          <div><p className="eyebrow">Historical {executionLabel(executionMode)} quote edge · {selectedSize.label}</p><h3 id="trend-title">{trendLeaderPartner && trend?.leader ? <>{trendLeaderPartner.name} leads over {trendDays} days</> : <>Performance over {trendDays} days</>}</h3><p>{trend?.leader ? `${formatBps(trend.leader.averageEdgeBps)} average edge · ${Math.round(trend.leader.winRate * 100)}% wins · ${Math.round(trend.leader.availability * 100)}% coverage · ${trend.leader.sampleCount} synchronized checks` : "A period leader appears after enough synchronized batches reach 80% quote coverage."}</p></div>
          <div className="trend-controls">
            <fieldset><legend>Period</legend><div className="segmented light">{([7, 14, 30] as const).map((days) => <button key={days} className={trendDays === days ? "selected" : ""} onClick={() => setTrendDays(days)}>{days}d</button>)}</div></fieldset>
          </div>
        </header>
        {trendLoading ? <div className="trend-empty"><b>Loading quote history…</b><span>Building the basis-point series for this route and size.</span></div> : trend ? <TrendChart data={trend} activePartners={activePartners} /> : <div className="trend-empty"><b>Trend unavailable</b><span>{trendError ?? "No historical quote data was returned."}</span></div>}
        <div className="trend-note"><b>Batch median baseline</b><span>Each protocol is measured against the median output from that exact synchronized batch. Positive basis points mean more destination asset.</span></div>
      </section>

      {requestsOpen && <div className="request-drawer-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) setRequestsOpen(false); }}>
        <aside className="request-drawer" role="dialog" aria-modal="true" aria-labelledby="request-drawer-title">
          <header><div><p className="eyebrow">Request audit</p><h2 id="request-drawer-title">{selectedRoute ? `${selectedRoute.source.symbol} → ${selectedRoute.destination.symbol}` : "Latest requests"}</h2></div><button onClick={() => setRequestsOpen(false)} aria-label="Close latest requests">×</button></header>
          <RequestDetails runDetails={runDetails} runLoading={runLoading} selectedSize={selectedSize} />
        </aside>
      </div>}
    </section>

    <footer><b>DEX Quote Tool</b><span>Real requests. Exact sizes. Explainable winners.</span><a href="#top">Back to top ↑</a></footer>
  </main>;
}
