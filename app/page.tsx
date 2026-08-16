"use client";

import { useEffect, useMemo, useState } from "react";
import { quoteSizes, type QuoteSize } from "../lib/quotes/sizes";

type PartnerId = "thorchain" | "chainflip" | "near-intents" | "maya";
type ViewWindow = "now" | "7d";

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
  marginPct?: number | null;
  tie?: boolean;
  successfulQuotes?: number;
  averageShortfallBps?: number | null;
  winRate?: number | null;
  sampleCount?: number;
  availability?: number | null;
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

const partners: Array<{ id: PartnerId; name: string; cellName: string; short: string; color: string }> = [
  { id: "thorchain", name: "THORChain", cellName: "THOR", short: "T", color: "#17b897" },
  { id: "chainflip", name: "Chainflip", cellName: "Flip", short: "C", color: "#ed49c9" },
  { id: "near-intents", name: "NEAR Intents", cellName: "NEAR", short: "N", color: "#171817" },
  { id: "maya", name: "Maya", cellName: "Maya", short: "M", color: "#ef6a38" },
];

function PartnerMark({ id, muted = false }: { id: PartnerId; muted?: boolean }) {
  const partner = partners.find((item) => item.id === id)!;
  return <span className={`partner-mark ${muted ? "muted" : ""}`} style={{ background: muted ? undefined : partner.color }} title={partner.name}>{partner.short}</span>;
}

function RoutePair({ route }: { route: Route }) {
  return <span className="route-pair"><span><b>{route.source.symbol}</b><small>{route.source.chain}</small></span><i aria-hidden="true">→</i><span><b>{route.destination.symbol}</b><small>{route.destination.chain}</small></span></span>;
}

function formatTime(value?: string) {
  if (!value) return "—";
  return new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function ComparisonResult({ cell, window }: { cell?: ComparisonCell; window: ViewWindow }) {
  if (!cell?.leader) return <span className="cell-empty"><b>—</b><small>No run</small></span>;
  const partner = partners.find((item) => item.id === cell.leader)!;
  if (window === "7d") {
    return <span className={`cell-result protocol-${cell.leader}`}><span><PartnerMark id={cell.leader} /><b>{partner.cellName}</b></span><strong>{Math.round((cell.winRate ?? 0) * 100)}% wins</strong><small>{cell.sampleCount ?? 0} comparable samples</small></span>;
  }
  return <span className={`cell-result protocol-${cell.leader}`}><span><PartnerMark id={cell.leader} /><b>{cell.tie ? "Tie" : partner.cellName}</b></span><strong>{cell.marginPct == null ? "Only quote" : cell.tie ? "≤ 2 bps" : `+${cell.marginPct.toFixed(cell.marginPct < 0.1 ? 3 : 2)}%`}</strong><small>{cell.successfulQuotes ?? 0} valid quotes</small></span>;
}

export default function Home() {
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [viewWindow, setViewWindow] = useState<ViewWindow>("now");
  const [comparison, setComparison] = useState<ComparisonResponse | null>(null);
  const [comparisonLoading, setComparisonLoading] = useState(true);
  const [comparisonRefresh, setComparisonRefresh] = useState(0);
  const [selectedRoute, setSelectedRoute] = useState<Route | null>(null);
  const [selectedSize, setSelectedSize] = useState<QuoteSize>(quoteSizes[3]);
  const [runDetails, setRunDetails] = useState<RunResponse | null>(null);
  const [runLoading, setRunLoading] = useState(false);
  const [runSubmitting, setRunSubmitting] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      try {
        const response = await fetch(`/api/routes?${new URLSearchParams({ search })}`, { signal: controller.signal });
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
  }, [search]);

  useEffect(() => {
    const controller = new AbortController();
    Promise.resolve().then(() => { if (!controller.signal.aborted) setComparisonLoading(true); });
    fetch(`/api/comparison?window=${viewWindow}`, { signal: controller.signal })
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
  }, [comparisonRefresh, viewWindow]);

  useEffect(() => {
    if (!selectedRoute) return;
    const controller = new AbortController();
    Promise.resolve().then(() => { if (!controller.signal.aborted) setRunLoading(true); });
    const params = new URLSearchParams({ routeId: selectedRoute.id, amountId: selectedSize.id });
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
  }, [selectedRoute, selectedSize.id]);

  const cells = useMemo(() => new Map((comparison?.cells ?? []).map((cell) => [`${cell.pairId}::${cell.amountId}`, cell])), [comparison]);
  const winnerProtocol = useMemo(() => (runDetails?.quotes ?? [])
    .filter((quote) => quote.status === "quoted" && quote.expectedOutputFormatted)
    .sort((a, b) => Number(b.expectedOutputFormatted) - Number(a.expectedOutputFormatted))[0]?.protocol, [runDetails]);

  function inspect(route: Route, size: QuoteSize) {
    setSelectedRoute(route);
    setSelectedSize(size);
    window.requestAnimationFrame(() => document.getElementById("requests")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  async function runTestQuote() {
    if (!selectedRoute) return;
    setRunSubmitting(true);
    setRunDetails(null);
    try {
      const response = await fetch("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ routeId: selectedRoute.id, amountId: selectedSize.id }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Test run failed");
      const latest = await fetch(`/api/runs?${new URLSearchParams({ routeId: selectedRoute.id, amountId: selectedSize.id })}`);
      const data = await latest.json() as RunResponse;
      if (!latest.ok) throw new Error(data.error ?? "Quote history unavailable");
      setRunDetails(data);
      setComparisonRefresh((value) => value + 1);
    } catch (error) {
      setRunDetails({ run: null, quotes: [], error: error instanceof Error ? error.message : "Test run failed" });
    } finally {
      setRunSubmitting(false);
    }
  }

  return <main className="app-shell" id="top">
    <header className="topbar">
      <a className="brand" href="#top"><span className="brand-symbol"><i /><i /><i /></span><span>Quote<span>Tool</span></span></a>
      <nav aria-label="Primary navigation"><a className="active" href="#leaderboard">Leaderboard</a><a href="#requests">Quote details</a></nav>
      <span className="truth-pill"><i /> Real quotes only</span>
    </header>

    <section className="hero">
      <div><p className="eyebrow">Cross-chain quote benchmark</p><h1>See who wins.<br /><em>At every size.</em></h1><p>Thirty fixed THORChain routes. Eight exact USD trade sizes. Every cell identifies the best comparable instant quote—or shows that no synchronized run exists yet.</p></div>
    </section>

    <section className="route-section" id="leaderboard">
      <div className="section-heading">
        <div><p className="eyebrow">Quote leaderboard</p><h2>Best protocol by size</h2></div>
        <p>{viewWindow === "now" ? "Now uses the latest synchronized batch and shows the winner’s advantage over second place." : "Seven days ranks each protocol by its normalized output across comparable batches; quotes are never compounded."}</p>
      </div>

      <div className="filter-bar leaderboard-tools">
        <label><span>Search 30 fixed routes</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="BTC, ETH, USDC…" /></label>
        <fieldset><legend>Comparison window</legend><div className="segmented"><button className={viewWindow === "now" ? "selected" : ""} onClick={() => setViewWindow("now")}>Now</button><button className={viewWindow === "7d" ? "selected" : ""} onClick={() => setViewWindow("7d")}>7 days</button></div></fieldset>
        <div className="catalog-stamp"><span>Route set frozen</span><b>{formatTime(catalog?.routeSet?.selectedAt)}</b></div>
      </div>

      {catalog?.error ? <div className="error-state"><b>Route catalog unavailable</b><span>{catalog.error}</span></div> : <div className={`leaderboard-wrap ${loading || comparisonLoading ? "loading" : ""}`}>
        <table className="leaderboard-table">
          <thead><tr><th>Directed route</th>{quoteSizes.map((size) => <th key={size.id}>{size.label}</th>)}</tr></thead>
          <tbody>{(catalog?.routes ?? []).map((route, index) => <tr key={route.id}>
            <th><button className="route-cell" onClick={() => inspect(route, selectedSize)}><small>{String(index + 1).padStart(2, "0")}</small><RoutePair route={route} /><span className="coverage-dots">{partners.map((partner) => <PartnerMark key={partner.id} id={partner.id} muted={!route.partners.includes(partner.id)} />)}</span></button></th>
            {quoteSizes.map((size) => <td key={size.id}><button className="result-button" onClick={() => inspect(route, size)} aria-label={`Inspect ${route.source.symbol} to ${route.destination.symbol} at ${size.label}`}><ComparisonResult cell={cells.get(`${route.id}::${size.id}`)} window={viewWindow} /></button></td>)}
          </tr>)}</tbody>
        </table>
        {!loading && catalog?.routes.length === 0 && <div className="empty-table">No fixed routes match this search.</div>}
      </div>}
      <div className="pagination"><span>{catalog?.counts?.filteredRoutes ?? 0} of 30 routes shown</span><b>Direction is treated separately · instant quote mode</b></div>
    </section>

    <section className="route-detail" id="requests">
      <div className="detail-header">
        <div><p className="eyebrow">Latest synchronized batch</p>{selectedRoute ? <h2 className="detail-route"><span>{selectedRoute.source.symbol}<small>{selectedRoute.source.chain}</small></span><i>→</i><span>{selectedRoute.destination.symbol}<small>{selectedRoute.destination.chain}</small></span></h2> : <h2>Select a route</h2>}</div>
        {selectedRoute && <div className="detail-actions"><div className="coverage-summary"><span>Quote partners</span><div>{partners.map((partner) => <PartnerMark key={partner.id} id={partner.id} muted={!selectedRoute.partners.includes(partner.id)} />)}</div></div><button className="run-button" onClick={runTestQuote} disabled={runSubmitting || runLoading}>{runSubmitting ? "Running four quotes…" : `Run ${selectedSize.label} test`}</button></div>}
      </div>

      <div className="range-layout">
        <div className="range-grid amount-grid">{quoteSizes.map((size) => <button key={size.id} className={selectedSize.id === size.id ? "selected" : ""} onClick={() => setSelectedSize(size)}><span>{size.label}</span><b>Exact USD input</b><small>{selectedSize.id === size.id && runDetails?.run ? `Last run ${formatTime(runDetails.run.initiatedAt)}` : "Same notional every run"}</small></button>)}</div>
        <aside className={`request-panel ${runDetails?.quotes.length ? "has-quotes" : ""}`}>
          <p className="eyebrow">Latest requests · {selectedSize.label}</p>
          {runLoading ? <><h3>Loading requests…</h3><p>Reading the latest synchronized batch from quote history.</p></> : runDetails?.run ? <>
            <h3>{runDetails.quotes.length} protocol results</h3>
            <p>Captured {formatTime(runDetails.run.initiatedAt)} · ${runDetails.run.sourceAmountUsd.toLocaleString()} exact input · synchronized within {runDetails.run.maxRequestSkewMs ?? "—"} ms</p>
            <div className="request-list">{runDetails.quotes.map((quote) => <details key={quote.id}>
              <summary><PartnerMark id={quote.protocol} /><span><b>{partners.find((partner) => partner.id === quote.protocol)?.name}</b><small>{quote.strategy} · {quote.responseLatencyMs ?? "—"} ms</small></span><strong className={winnerProtocol === quote.protocol ? "winner" : ""}>{winnerProtocol === quote.protocol ? "Best output" : quote.status}</strong></summary>
              <dl><div><dt>Requested</dt><dd>{formatTime(quote.requestStartedAt)}</dd></div><div><dt>HTTP status</dt><dd>{quote.responseHttpStatus ?? "—"}</dd></div><div><dt>Expected output</dt><dd>{quote.expectedOutputFormatted ?? quote.expectedOutputBaseUnits ?? "—"}</dd></div><div><dt>Quote expiry</dt><dd>{formatTime(quote.quoteExpiresAt ?? undefined)}</dd></div></dl>
              <span className="json-label">Request</span><pre>{quote.requestPayloadJson ?? quote.requestUrl ?? "No request payload stored"}</pre><span className="json-label">Response</span><pre>{quote.rawResponseJson ?? quote.errorMessage ?? "No response payload stored"}</pre>
            </details>)}</div>
          </> : <><h3>No captured requests yet</h3><p>{runDetails?.error ?? "Choose an exact trade size and run a test. All four protocol results—including unsupported and failed requests—will appear together."}</p><dl><div><dt>Request timestamp</dt><dd>—</dd></div><div><dt>Exact input amount</dt><dd>{selectedSize.label}</dd></div><div><dt>Response latency</dt><dd>—</dd></div><div><dt>Raw request / response</dt><dd>Available after first run</dd></div></dl></>}
        </aside>
      </div>
    </section>

    <section className="partner-health"><div><p className="eyebrow">Metadata endpoints</p><h2>Partner status</h2></div><div className="health-grid">{partners.map((partner) => { const status = catalog?.statuses?.[partner.id]; return <article key={partner.id}><PartnerMark id={partner.id} /><div><b>{partner.name}</b><small>{status?.available ? "Catalog connected" : loading ? "Checking…" : "Catalog unavailable"}</small></div><span className={status?.available ? "online" : "offline"} /></article>; })}</div></section>
    <footer><b>QuoteTool</b><span>Real requests. Exact sizes. Explainable winners.</span><a href="#top">Back to top ↑</a></footer>
  </main>;
}
