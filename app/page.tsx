"use client";

import { useEffect, useMemo, useState } from "react";

type PartnerId = "thorchain" | "chainflip" | "near-intents" | "maya";

type Route = {
  id: string;
  source: { id: string; label: string; chain: string; symbol: string; thorAsset: string };
  destination: { id: string; label: string; chain: string; symbol: string; thorAsset: string };
  partners: PartnerId[];
};

type CatalogResponse = {
  generatedAt: string;
  statuses: Record<PartnerId, { available: boolean; error?: string }>;
  counts: {
    thorAssets: number;
    allRoutes: number;
    comparableRoutes: number;
    scheduledRoutes: number;
    filteredRoutes: number;
    partnerRouteCounts: Record<PartnerId, number>;
    scheduledRequests: number;
  };
  routes: Route[];
  page: number;
  pages: number;
  ranking?: { metric: string; description: string };
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
    responseReceivedAt?: string | null;
    responseLatencyMs?: number | null;
    responseHttpStatus?: number | null;
    quoteExpiresAt?: string | null;
    requestUrl?: string | null;
    requestPayloadJson?: string | null;
    rawResponseJson?: string | null;
    errorMessage?: string | null;
  }>;
  migrationPending?: boolean;
  error?: string;
};

const partners: Array<{ id: PartnerId; name: string; short: string; color: string }> = [
  { id: "thorchain", name: "THORChain", short: "T", color: "#17b897" },
  { id: "chainflip", name: "Chainflip", short: "C", color: "#ed49c9" },
  { id: "near-intents", name: "NEAR Intents", short: "N", color: "#171817" },
  { id: "maya", name: "Maya", short: "M", color: "#ef6a38" },
];

const ranges = [
  { id: "1-100", label: "$1 – <$100" },
  { id: "100-1000", label: "$100 – <$1K" },
  { id: "1000-10000", label: "$1K – <$10K" },
  { id: "10000-50000", label: "$10K – <$50K" },
  { id: "50000-100000", label: "$50K – <$100K" },
  { id: "100000-200000", label: "$100K – <$200K" },
  { id: "200000-500000", label: "$200K – <$500K" },
  { id: "500000-1000000", label: "$500K – $1M" },
];

function PartnerMark({ id, muted = false }: { id: PartnerId; muted?: boolean }) {
  const partner = partners.find((item) => item.id === id)!;
  return <span className={`partner-mark ${muted ? "muted" : ""}`} style={{ background: muted ? undefined : partner.color }} title={partner.name}>{partner.short}</span>;
}

function RoutePair({ route }: { route: Route }) {
  return (
    <span className="route-pair">
      <span><b>{route.source.symbol}</b><small>{route.source.chain}</small></span>
      <i aria-hidden="true">→</i>
      <span><b>{route.destination.symbol}</b><small>{route.destination.chain}</small></span>
    </span>
  );
}

function formatTime(value?: string) {
  if (!value) return "—";
  return new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export default function Home() {
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [selectedRoute, setSelectedRoute] = useState<Route | null>(null);
  const [selectedRange, setSelectedRange] = useState(ranges[3]);
  const [runDetails, setRunDetails] = useState<RunResponse | null>(null);
  const [runLoading, setRunLoading] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ search });
        const response = await fetch(`/api/routes?${params}`, { signal: controller.signal });
        const data = await response.json() as CatalogResponse;
        if (!response.ok) throw new Error(data.error ?? "Route catalog unavailable");
        setCatalog(data);
        setSelectedRoute((current) => current && data.routes.some((route) => route.id === current.id) ? current : data.routes[0] ?? null);
      } catch (error) {
        if (!controller.signal.aborted) setCatalog({ error: error instanceof Error ? error.message : "Route catalog unavailable" } as CatalogResponse);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [search]);

  useEffect(() => {
    if (!selectedRoute) { setRunDetails(null); return; }
    const controller = new AbortController();
    setRunLoading(true);
    const params = new URLSearchParams({ routeId: selectedRoute.id, rangeId: selectedRange.id });
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
  }, [selectedRange.id, selectedRoute]);

  const requestEstimate = useMemo(() => {
    return catalog?.counts?.scheduledRequests ?? 0;
  }, [catalog]);

  return (
    <main className="app-shell" id="top">
      <header className="topbar">
        <a className="brand" href="#top"><span className="brand-symbol"><i /><i /><i /></span><span>Quote<span>Tool</span></span></a>
        <nav aria-label="Primary navigation"><a className="active" href="#routes">Routes</a><a href="#collection">Collection</a><a href="#requests">Requests</a></nav>
        <span className="truth-pill"><i /> Real data only</span>
      </header>

      <section className="hero">
        <div>
          <p className="eyebrow">THORChain-led route intelligence</p>
          <h1>Every route.<br /><em>Every comparable quote.</em></h1>
          <p>THORChain defines the route universe. For now, QuoteTool tracks its 20 most active routes, checks which partners support the exact same assets, and preserves every request for inspection.</p>
        </div>
        <aside className="schedule-card">
          <div><span className="pulse amber" /><b>Collection not active</b></div>
          <strong>15 <small>minute target</small></strong>
          <p>The top-20 route catalog below is live. Quote history remains empty until the first scheduled collection and NEAR credentials are enabled.</p>
        </aside>
      </section>

      <section className="metric-grid" aria-label="Live route catalog summary">
        <article><span>THORChain assets</span><strong>{catalog?.counts?.thorAssets ?? "—"}</strong><small>Available pools + native RUNE</small></article>
        <article><span>THORChain universe</span><strong>{catalog?.counts?.allRoutes?.toLocaleString() ?? "—"}</strong><small>Available for future expansion</small></article>
        <article className="accent"><span>Routes in scope</span><strong>{catalog?.counts?.scheduledRoutes ?? "—"}</strong><small>Ranked by 24-hour pool activity</small></article>
        <article><span>Estimated requests / cycle</span><strong>{requestEstimate.toLocaleString()}</strong><small>One midpoint per range</small></article>
      </section>

      <section className="route-section" id="routes">
        <div className="section-heading">
          <div><p className="eyebrow">Live coverage catalog</p><h2>Routes</h2></div>
          <p>Top 20 directed routes ranked from current THORChain pool activity. Select one to inspect its ranges and captured requests.</p>
        </div>

        <div className="filter-bar">
          <label><span>Search top 20</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="BTC, ETH, USDC…" /></label>
          <div className="ranking-note"><span>Ranking</span><b>24h pool activity</b></div>
          <div className="catalog-stamp"><span>Catalog snapshot</span><b>{formatTime(catalog?.generatedAt)}</b></div>
        </div>

        {catalog?.error ? <div className="error-state"><b>Live catalog unavailable</b><span>{catalog.error}</span></div> : (
          <div className={`route-table-wrap ${loading ? "loading" : ""}`}>
            <table className="route-table">
              <thead><tr><th>Route</th><th>Protocol coverage</th><th>Latest run</th><th>Run state</th><th /></tr></thead>
              <tbody>
                {(catalog?.routes ?? []).map((route) => (
                  <tr key={route.id} className={selectedRoute?.id === route.id ? "selected" : ""} onClick={() => setSelectedRoute(route)} tabIndex={0} onKeyDown={(event) => { if (event.key === "Enter") setSelectedRoute(route); }}>
                    <td><RoutePair route={route} /></td>
                    <td><span className="partner-stack">{partners.map((partner) => <PartnerMark key={partner.id} id={partner.id} muted={!route.partners.includes(partner.id)} />)}<small>{route.partners.length}/4</small></span></td>
                    <td><span className="no-run">No captured quote</span></td>
                    <td><span className="state waiting">Awaiting run</span></td>
                    <td><button className="inspect-button" aria-label={`Inspect ${route.source.symbol} to ${route.destination.symbol}`}>Inspect →</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!loading && catalog?.routes.length === 0 && <div className="empty-table">No THORChain routes match this filter.</div>}
          </div>
        )}

        <div className="pagination">
          <span>{catalog?.counts?.filteredRoutes?.toLocaleString() ?? 0} of 20 routes shown</span>
          <b>Direction is treated separately</b>
        </div>
      </section>

      <section className="route-detail" id="requests">
        <div className="detail-header">
          <div><p className="eyebrow">Route drill-down</p>{selectedRoute ? <h2><RoutePair route={selectedRoute} /></h2> : <h2>Select a route</h2>}</div>
          {selectedRoute && <div className="coverage-summary"><span>Quote partners</span><div>{partners.map((partner) => <PartnerMark key={partner.id} id={partner.id} muted={!selectedRoute.partners.includes(partner.id)} />)}</div></div>}
        </div>

        <div className="range-layout">
          <div className="range-grid">
            {ranges.map((range) => (
              <button key={range.id} className={selectedRange.id === range.id ? "selected" : ""} onClick={() => setSelectedRange(range)}>
                <span>{range.label}</span><b>No completed run</b><small>Latest requests will appear here</small>
              </button>
            ))}
          </div>
          <aside className={`request-panel ${runDetails?.quotes.length ? "has-quotes" : ""}`}>
            <p className="eyebrow">Latest requests · {selectedRange.label}</p>
            {runLoading ? <><h3>Loading requests…</h3><p>Reading the latest synchronized batch from quote history.</p></> : runDetails?.run ? <>
              <h3>{runDetails.quotes.length} partner request{runDetails.quotes.length === 1 ? "" : "s"}</h3>
              <p>Captured {formatTime(runDetails.run.initiatedAt)} · ${runDetails.run.sourceAmountUsd.toLocaleString()} input · {runDetails.run.mode}</p>
              <div className="request-list">
                {runDetails.quotes.map((quote) => (
                  <details key={quote.id}>
                    <summary><PartnerMark id={quote.protocol} /><span><b>{partners.find((partner) => partner.id === quote.protocol)?.name}</b><small>{quote.strategy} · {quote.responseLatencyMs ?? "—"} ms</small></span><strong>{quote.status}</strong></summary>
                    <dl>
                      <div><dt>Requested</dt><dd>{formatTime(quote.requestStartedAt)}</dd></div>
                      <div><dt>HTTP status</dt><dd>{quote.responseHttpStatus ?? "—"}</dd></div>
                      <div><dt>Expected output</dt><dd>{quote.expectedOutputFormatted ?? quote.expectedOutputBaseUnits ?? "—"}</dd></div>
                      <div><dt>Quote expiry</dt><dd>{formatTime(quote.quoteExpiresAt ?? undefined)}</dd></div>
                    </dl>
                    <span className="json-label">Request</span><pre>{quote.requestPayloadJson ?? quote.requestUrl ?? "No request payload stored"}</pre>
                    <span className="json-label">Response</span><pre>{quote.rawResponseJson ?? quote.errorMessage ?? "No response payload stored"}</pre>
                  </details>
                ))}
              </div>
            </> : <>
              <h3>No captured requests yet</h3>
              <p>{runDetails?.error ?? "Once collection starts, this panel will list every partner request from the latest synchronized batch."}</p>
              <dl>
                <div><dt>Request timestamp</dt><dd>—</dd></div>
                <div><dt>Exact input amount</dt><dd>—</dd></div>
                <div><dt>Response latency</dt><dd>—</dd></div>
                <div><dt>Quote expiry</dt><dd>—</dd></div>
                <div><dt>Raw request / response</dt><dd>Available after first run</dd></div>
              </dl>
            </>}
          </aside>
        </div>
      </section>

      <section className="collection-section" id="collection">
        <div><p className="eyebrow">Collection design</p><h2>A complete audit trail,<br />without pretending scale is free.</h2></div>
        <div className="collection-list">
          <article><span>01</span><div><h3>Popularity refresh</h3><p>Re-rank the THORChain route universe using current 24-hour pool activity before each collection cycle.</p></div><b>Top 20 routes</b></article>
          <article><span>02</span><div><h3>15-minute quote sweep</h3><p>One representative midpoint per range, launched as synchronized batches only for partners supporting that exact route.</p></div><b>~{requestEstimate.toLocaleString()} requests</b></article>
          <article><span>03</span><div><h3>Deep range scan</h3><p>Low, geometric midpoint, and high samples for a selected route and range, with crossover refinement when winners differ.</p></div><b>On demand</b></article>
        </div>
      </section>

      <section className="partner-health">
        <div><p className="eyebrow">Metadata endpoints</p><h2>Partner status</h2></div>
        <div className="health-grid">
          {partners.map((partner) => {
            const status = catalog?.statuses?.[partner.id];
            return <article key={partner.id}><PartnerMark id={partner.id} /><div><b>{partner.name}</b><small>{status?.available ? "Catalog connected" : loading ? "Checking…" : "Catalog unavailable"}</small></div><span className={status?.available ? "online" : "offline"} /></article>;
          })}
        </div>
      </section>

      <footer><b>QuoteTool</b><span>Real requests. Stored responses. Explainable winners.</span><a href="#top">Back to top ↑</a></footer>
    </main>
  );
}
