"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

type PartnerId = "thorchain" | "maya" | "chainflip" | "near-intents";
type PeriodDays = 1 | 7 | 30;
type Theme = "dark" | "light";
type AssetLabel = { id: string; symbol: string; chain: string };
type RouteLabel = {
  routeId: string;
  source: AssetLabel;
  destination: AssetLabel;
  supportedProtocols: PartnerId[];
};
type RouteResult = {
  protocol: PartnerId;
  supported: boolean;
  bestQuoteRate: number | null;
  wins: number;
  eligibleChecks: number;
  availability: number | null;
  pairwiseBeatRate: number | null;
  pairwiseMatchups: number;
  medianOracleGapBps: number | null;
};
type AnalyticsResponse = {
  generatedAt: string;
  period: { days: PeriodDays; currentStart: string; currentEnd: string };
  selectedAmount: { id: string; amountUsd: number; label: string };
  selectedRoute: RouteLabel;
  routes: RouteLabel[];
  overview: Array<{
    protocol: PartnerId;
    supportedRoutes: number;
    coverage: number | null;
    availability: number | null;
    eligibleChecks: number;
    observedSince: string | null;
  }>;
  routeSummaries: RouteResult[];
  sizeRows: Array<{
    amount: { id: string; amountUsd: number; label: string };
    leader: PartnerId | null;
    results: Array<RouteResult & { rank: number | null }>;
  }>;
  timeline: Array<{
    bucket: string;
    results: Array<{ protocol: PartnerId; pairwiseBeatRate: number | null; matchups: number }>;
  }>;
  definitions: { bestQuoteRate: string; pairwise: string; availability: string; oracle: string };
  error?: string;
};

const partners: Array<{ id: PartnerId; name: string; shortName: string; color: string; logo: string }> = [
  { id: "thorchain", name: "THORChain", shortName: "THOR", color: "#17b897", logo: "/partners/thorchain.png" },
  { id: "maya", name: "MAYA Protocol", shortName: "MAYA", color: "#ef6a38", logo: "/partners/maya.svg" },
  { id: "chainflip", name: "Chainflip", shortName: "CHAINFLIP", color: "#ed49c9", logo: "/partners/chainflip.svg" },
  { id: "near-intents", name: "NEAR Intents", shortName: "NEAR", color: "var(--near-series)", logo: "/partners/near.svg" },
];

const sizes = [
  { id: "500", label: "$500" },
  { id: "1000", label: "$1K" },
  { id: "10000", label: "$10K" },
  { id: "50000", label: "$50K" },
  { id: "100000", label: "$100K" },
  { id: "500000", label: "$500K" },
  { id: "1000000", label: "$1M" },
];

function partner(id: PartnerId | null) {
  return partners.find((item) => item.id === id);
}

function percent(value: number | null, digits = 0) {
  return value == null ? "—" : `${(value * 100).toFixed(digits)}%`;
}

function bps(value: number | null) {
  if (value == null) return "—";
  const rounded = Math.round(value);
  return `${rounded > 0 ? "+" : ""}${rounded} bps`;
}

function winCount(value: number) {
  return Number.isInteger(value) ? value.toLocaleString() : value.toLocaleString([], { maximumFractionDigits: 1 });
}

function chainLabel(value: string) {
  return value.replace(/(^|[-_ ])\w/g, (match) => match.toUpperCase());
}

function routeLabel(route: RouteLabel) {
  return `${route.source.symbol} → ${route.destination.symbol} · ${chainLabel(route.source.chain)} → ${chainLabel(route.destination.chain)}`;
}

function PartnerLogo({ id }: { id: PartnerId }) {
  const item = partner(id)!;
  // These tiny bundled SVG/PNG marks do not benefit from an image optimizer request.
  // eslint-disable-next-line @next/next/no-img-element
  return <span className={`analytics-partner-logo logo-${id}`}><img src={item.logo} alt="" /></span>;
}

function TimelineChart({ data }: { data: AnalyticsResponse["timeline"] }) {
  if (!data.length) return <div className="analytics-empty"><b>No head-to-head trend yet</b><span>This route and size need at least two valid quotes in the same comparison.</span></div>;
  const width = 960;
  const height = 280;
  const padding = { top: 26, right: 18, bottom: 30, left: 48 };
  const x = (index: number) => padding.left + index / Math.max(1, data.length - 1) * (width - padding.left - padding.right);
  const y = (value: number) => padding.top + (1 - Math.min(1, Math.max(0, value))) * (height - padding.top - padding.bottom);
  const ticks = [1, 0.5, 0];

  return <div className="analytics-chart-wrap">
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Pairwise quote beat rate over time for the selected route">
      {ticks.map((tick) => <g key={tick}><line className="analytics-grid-line" x1={padding.left} x2={width - padding.right} y1={y(tick)} y2={y(tick)} strokeDasharray={tick === 0.5 ? "5 5" : undefined} /><text x={padding.left - 9} y={y(tick) + 3} textAnchor="end">{percent(tick)}</text></g>)}
      <text x={padding.left} y={height - 7}>{new Date(data[0].bucket).toLocaleDateString([], { month: "short", day: "numeric" })}</text>
      <text x={width - padding.right} y={height - 7} textAnchor="end">{new Date(data[data.length - 1].bucket).toLocaleDateString([], { month: "short", day: "numeric" })}</text>
      {partners.map((item) => {
        const segments: Array<Array<{ index: number; value: number; matchups: number }>> = [];
        let current: Array<{ index: number; value: number; matchups: number }> | undefined;
        data.forEach((bucket, index) => {
          const result = bucket.results.find((entry) => entry.protocol === item.id);
          if (result?.pairwiseBeatRate == null) {
            current = undefined;
            return;
          }
          if (!current) {
            current = [];
            segments.push(current);
          }
          current.push({ index, value: result.pairwiseBeatRate, matchups: result.matchups });
        });
        return <g key={item.id}>
          {segments.map((segment, index) => <polyline key={index} points={segment.map((point) => `${x(point.index)},${y(point.value)}`).join(" ")} fill="none" stroke={item.color} strokeWidth="2.5" vectorEffect="non-scaling-stroke" />)}
          {segments.flat().map((point) => <circle key={point.index} cx={x(point.index)} cy={y(point.value)} r="3" fill={item.color}><title>{item.name} · {percent(point.value, 1)} · {point.matchups.toLocaleString()} matchups</title></circle>)}
        </g>;
      })}
    </svg>
    <div className="analytics-chart-legend">{partners.map((item) => <span key={item.id}><i style={{ background: item.color }} />{item.name}</span>)}</div>
  </div>;
}

export default function AnalyticsDashboard() {
  const [days, setDays] = useState<PeriodDays>(7);
  const [amountId, setAmountId] = useState("50000");
  const [routeId, setRouteId] = useState("");
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useState<Theme>("dark");

  useEffect(() => {
    const timer = window.setTimeout(() => setTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark"), 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError(null);
      const params = new URLSearchParams({ days: String(days), amountId });
      if (routeId) params.set("routeId", routeId);
      fetch(`/api/analytics?${params}`, { signal: controller.signal })
        .then(async (response) => {
          const payload = await response.json() as AnalyticsResponse;
          if (!response.ok) throw new Error(payload.error ?? "Analytics unavailable");
          return payload;
        })
        .then((payload) => setData(payload))
        .catch((reason) => {
          if (reason instanceof DOMException && reason.name === "AbortError") return;
          setError(reason instanceof Error ? reason.message : "Analytics unavailable");
        })
        .finally(() => setLoading(false));
    }, 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [days, amountId, routeId]);

  const selectedRouteId = routeId || data?.selectedRoute.routeId || "";
  const orderedRoutes = useMemo(() => [...(data?.routes ?? [])].sort((left, right) => routeLabel(left).localeCompare(routeLabel(right))), [data?.routes]);
  const dataThrough = data ? new Date(new Date(data.period.currentEnd).getTime() - (days === 1 ? 0 : 1)) : null;

  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("swaprank-theme", next); } catch { /* Theme still applies for this page view. */ }
  }

  return <main className="app-shell">
    <header className="topbar">
      <Link className="brand" href="/" aria-label="SwapRank home"><span className="brand-symbol"><i /><i /><i /></span><span>Swap<span>Rank</span></span></Link>
      <div className="top-actions"><nav aria-label="Primary navigation"><Link href="/">Leaderboard</Link><Link className="active" href="/analytics">Analytics</Link></nav><button className="theme-toggle" onClick={toggleTheme} title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}><svg className="theme-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{theme === "dark" ? <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42" /></> : <path d="M20.9 13.1A9 9 0 0 1 10.9 3.1a9 9 0 1 0 10 10Z" />}</svg><b>{theme === "dark" ? "Light" : "Dark"}</b></button></div>
    </header>

    <section className="analytics-page">
      <header className="analytics-heading">
        <div><p className="eyebrow">Market data / route comparison</p><h1>ROUTE ANALYTICS</h1><p>Compare like-for-like execution across every tracked trade size, while keeping coverage and reliability separate.</p></div>
        <div className="analytics-freshness"><span>DATA THROUGH</span><strong>{dataThrough ? dataThrough.toLocaleString([], days === 1 ? { hour: "numeric", minute: "2-digit" } : { month: "short", day: "numeric" }) : "—"}</strong><small>{days === 1 ? "Rolling 24-hour window" : "Complete UTC days"}</small></div>
      </header>

      <section className="analytics-toolbar analytics-route-toolbar" aria-label="Analytics filters">
        <fieldset><legend>Period</legend><div className="segmented">{([1, 7, 30] as PeriodDays[]).map((value) => <button key={value} className={days === value ? "selected" : ""} onClick={() => setDays(value)}>{value === 1 ? "24 hours" : `${value} days`}</button>)}</div></fieldset>
        <fieldset className="analytics-route-picker"><legend>Route</legend><select value={selectedRouteId} onChange={(event) => setRouteId(event.target.value)} aria-label="Select route">{orderedRoutes.map((route) => <option value={route.routeId} key={route.routeId}>{routeLabel(route)}</option>)}</select></fieldset>
      </section>

      {error && <div className="error-state"><b>Analytics unavailable</b><span>{error}</span></div>}
      {loading && !data && <div className="analytics-loading" role="status">Building route comparison…</div>}

      {data && <div className={loading ? "analytics-content refreshing" : "analytics-content"}>
        <section className="analytics-overview">
          <header><div><p className="eyebrow">DEX footprint</p><h2>Coverage and reliability</h2><p>Portfolio-level context across all 50 routes and all seven sizes. Price performance is compared below only on the selected route.</p></div></header>
          <div className="analytics-summary-grid">{partners.map((item) => {
            const overview = data.overview.find((entry) => entry.protocol === item.id);
            return <article className="analytics-summary-card analytics-overview-card" key={item.id} style={{ borderTopColor: item.color }}>
              <header><PartnerLogo id={item.id} /><div><span>{item.name}</span><small>{overview?.eligibleChecks.toLocaleString() ?? 0} eligible checks</small></div></header>
              <strong>{percent(overview?.coverage ?? null, 0)}</strong><span>route coverage · {overview?.supportedRoutes ?? 0} of {data.routes.length}</span>
              <dl><div><dt>Quote availability</dt><dd>{percent(overview?.availability ?? null, 1)}</dd></div><div><dt>Observed since</dt><dd>{overview?.observedSince ? new Date(overview.observedSince).toLocaleDateString([], { month: "short", day: "numeric" }) : "—"}</dd></div></dl>
            </article>;
          })}</div>
        </section>

        <section className="analytics-route-heading">
          <div><p className="eyebrow">Selected route</p><h2>{data.selectedRoute.source.symbol} <span>→</span> {data.selectedRoute.destination.symbol}</h2><p>{chainLabel(data.selectedRoute.source.chain)} → {chainLabel(data.selectedRoute.destination.chain)} · all seven tracked sizes</p></div>
          <Link href={`/routes/${encodeURIComponent(data.selectedRoute.routeId)}?size=${amountId}&days=${days}`}>Open detailed route →</Link>
        </section>

        <section className="analytics-summary-grid" aria-label="Selected route DEX comparison">
          {partners.map((item) => {
            const summary = data.routeSummaries.find((entry) => entry.protocol === item.id)!;
            return <article className={`analytics-summary-card ${summary.supported ? "" : "unsupported"}`} key={item.id} style={{ borderTopColor: item.color }}>
              <header><PartnerLogo id={item.id} /><div><span>{item.name}</span><small>{summary.supported ? "Eligible on this route" : "Route unsupported"}</small></div><b>{summary.supported ? `${summary.pairwiseMatchups.toLocaleString()} matchups` : "N/A"}</b></header>
              <strong>{summary.supported ? percent(summary.bestQuoteRate, 1) : "N/A"}</strong><span>{summary.supported ? `best quote · ${winCount(summary.wins)} of ${summary.eligibleChecks.toLocaleString()} checks` : "not included in scoring"}</span>
              <dl><div><dt>Availability</dt><dd>{percent(summary.availability, 1)}</dd></div><div><dt>Opponent quotes beaten</dt><dd>{percent(summary.pairwiseBeatRate, 1)}</dd></div><div><dt>Median vs oracle</dt><dd>{bps(summary.medianOracleGapBps)}</dd></div></dl>
            </article>;
          })}
        </section>

        <section className="analytics-panel analytics-routes analytics-size-matrix">
          <header><div><p className="eyebrow">Execution by trade size</p><h2>Where the winner changes</h2><p>Best-quote rate over the selected period. Rank reflects the chance of serving the best available quote at each exact input size.</p></div><span>{data.selectedRoute.source.symbol} → {data.selectedRoute.destination.symbol}</span></header>
          <div className="analytics-route-table-wrap"><table><thead><tr><th>Size</th><th>Period leader</th>{partners.map((item) => <th key={item.id}>{item.shortName}</th>)}</tr></thead><tbody>{data.sizeRows.map((row) => <tr key={row.amount.id}>
            <th><b>{row.amount.label}</b><small>Exact USD input</small></th>
            <td>{row.leader ? <span className="analytics-route-leader"><PartnerLogo id={row.leader} /><span><b>{partner(row.leader)?.name}</b><small>Most frequent winner</small></span></span> : <span className="analytics-na">No quotes</span>}</td>
            {partners.map((item) => {
              const result = row.results.find((entry) => entry.protocol === item.id)!;
              return <td key={item.id} className={!result.supported ? "unsupported" : ""}>{result.supported ? <span className="analytics-heat" style={{ background: `color-mix(in srgb, ${item.color} ${Math.max(8, Math.round((result.bestQuoteRate ?? 0) * 68))}%, var(--card))` }}><b>{result.rank ? `#${result.rank} · ` : ""}{percent(result.bestQuoteRate, 0)}</b><small>{percent(result.availability, 0)} available · {percent(result.pairwiseBeatRate, 0)} opponents beaten</small></span> : <span className="analytics-na">N/A</span>}</td>;
            })}
          </tr>)}</tbody></table></div>
        </section>

        <section className="analytics-panel">
          <header><div><p className="eyebrow">Price competitiveness over time</p><h2>Opponent quotes beaten · {data.selectedAmount.label}</h2><p>Route-specific head-to-head pricing. Second place receives credit for the competitors it beat; 50% is the neutral baseline.</p></div><div className="analytics-size-filter">{sizes.map((size) => <button key={size.id} className={amountId === size.id ? "selected" : ""} onClick={() => setAmountId(size.id)}>{size.label}</button>)}</div></header>
          <TimelineChart data={data.timeline} />
        </section>

        <aside className="analytics-method analytics-route-method">
          <header><p className="eyebrow">How to read this</p><h2>No single score</h2></header><p>{data.definitions.bestQuoteRate}</p><p>{data.definitions.pairwise}</p><p>{data.definitions.availability}</p><p>{data.definitions.oracle}</p><div><b>N/A</b><span>The DEX does not support this route and receives no loss or availability penalty.</span></div>
        </aside>
      </div>}
    </section>

    <footer><b>SwapRank</b><span><Link href="/">← Leaderboard</Link> · <a href="https://github.com/gerritsa/DEXQuoteTool">GitHub</a></span></footer>
  </main>;
}
