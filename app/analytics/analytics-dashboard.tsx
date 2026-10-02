"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

type PartnerId = "thorchain" | "maya" | "chainflip" | "near-intents";
type PeriodDays = 1 | 7 | 30;
type Theme = "dark" | "light";
type ResultMetric = {
  protocol: PartnerId;
  supported: boolean;
  winShare: number | null;
  availability: number | null;
  averageOracleGapBps: number | null;
  eligibleChecks: number;
  change: number | null;
};
type AnalyticsResponse = {
  generatedAt: string;
  period: { days: PeriodDays; currentStart: string; currentEnd: string; previousStart: string };
  amount: { id: string; amountUsd: number; label: string };
  definitions: { winRate: string; availability: string };
  summaries: Array<{
    protocol: PartnerId;
    winRate: number | null;
    availability: number | null;
    averageOracleGapBps: number | null;
    supportedRoutes: number;
    eligibleChecks: number;
    wins: number;
    change: number | null;
  }>;
  timeline: Array<{
    bucket: string;
    results: Array<{ protocol: PartnerId; winRate: number | null; eligibleChecks: number }>;
  }>;
  routes: Array<{
    routeId: string;
    source: { id: string; symbol: string; chain: string };
    destination: { id: string; symbol: string; chain: string };
    supportedProtocols: PartnerId[];
    comparisonCount: number;
    leader: PartnerId | null;
    leaderWinShare: number | null;
    previousLeader: PartnerId | null;
    leaderChanged: boolean;
    results: ResultMetric[];
  }>;
  movers: Array<{
    routeId: string;
    source: { id: string; symbol: string; chain: string };
    destination: { id: string; symbol: string; chain: string };
    protocol: PartnerId;
    change: number;
    leaderChanged: boolean;
  }>;
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

function delta(value: number | null) {
  if (value == null) return "No prior data";
  const points = value * 100;
  if (Math.abs(points) < 0.05) return "No change";
  return `${points > 0 ? "↑" : "↓"} ${Math.abs(points).toFixed(1)} pp`;
}

function chainLabel(value: string) {
  return value.replace(/(^|[-_ ])\w/g, (match) => match.toUpperCase());
}

function PartnerLogo({ id }: { id: PartnerId }) {
  const item = partner(id)!;
  // These tiny bundled SVG/PNG marks do not benefit from an image optimizer request.
  // eslint-disable-next-line @next/next/no-img-element
  return <span className={`analytics-partner-logo logo-${id}`}><img src={item.logo} alt="" /></span>;
}

function TimelineChart({ data }: { data: AnalyticsResponse["timeline"] }) {
  if (!data.length) return <div className="analytics-empty"><b>No trend data yet</b><span>The chart will populate after eligible comparisons are aggregated.</span></div>;
  const width = 960;
  const height = 280;
  const padding = { top: 26, right: 18, bottom: 30, left: 48 };
  const observed = data.flatMap((bucket) => bucket.results.flatMap((result) => result.winRate == null ? [] : [result.winRate]));
  const ceiling = Math.max(0.25, Math.ceil((Math.max(...observed, 0) + 0.02) * 10) / 10);
  const x = (index: number) => padding.left + index / Math.max(1, data.length - 1) * (width - padding.left - padding.right);
  const y = (value: number) => padding.top + (1 - Math.min(ceiling, Math.max(0, value)) / ceiling) * (height - padding.top - padding.bottom);
  const ticks = [ceiling, ceiling / 2, 0];

  return <div className="analytics-chart-wrap">
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Supported-route win rate over time">
      {ticks.map((tick) => <g key={tick}><line className="analytics-grid-line" x1={padding.left} x2={width - padding.right} y1={y(tick)} y2={y(tick)} /><text x={padding.left - 9} y={y(tick) + 3} textAnchor="end">{percent(tick)}</text></g>)}
      <text x={padding.left} y={height - 7}>{new Date(data[0].bucket).toLocaleDateString([], { month: "short", day: "numeric" })}</text>
      <text x={width - padding.right} y={height - 7} textAnchor="end">{new Date(data[data.length - 1].bucket).toLocaleDateString([], { month: "short", day: "numeric" })}</text>
      {partners.map((item) => {
        const segments: Array<Array<{ index: number; value: number }>> = [];
        let current: Array<{ index: number; value: number }> | undefined;
        data.forEach((bucket, index) => {
          const value = bucket.results.find((result) => result.protocol === item.id)?.winRate;
          if (value == null) {
            current = undefined;
            return;
          }
          if (!current) {
            current = [];
            segments.push(current);
          }
          current.push({ index, value });
        });
        return <g key={item.id}>
          {segments.map((segment, index) => <polyline key={index} points={segment.map((point) => `${x(point.index)},${y(point.value)}`).join(" ")} fill="none" stroke={item.color} strokeWidth="2.5" vectorEffect="non-scaling-stroke" />)}
          {segments.flat().map((point) => <circle key={point.index} cx={x(point.index)} cy={y(point.value)} r="3" fill={item.color}><title>{item.name} · {percent(point.value, 1)}</title></circle>)}
        </g>;
      })}
    </svg>
    <div className="analytics-chart-legend">{partners.map((item) => <span key={item.id}><i style={{ background: item.color }} />{item.name}</span>)}</div>
  </div>;
}

export default function AnalyticsDashboard() {
  const [days, setDays] = useState<PeriodDays>(7);
  const [amountId, setAmountId] = useState("50000");
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useState<Theme>("dark");
  const [showAllRoutes, setShowAllRoutes] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark"), 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError(null);
      fetch(`/api/analytics?days=${days}&amountId=${amountId}`, { signal: controller.signal })
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
  }, [days, amountId]);

  const visibleRoutes = useMemo(() => showAllRoutes ? data?.routes ?? [] : (data?.routes ?? []).slice(0, 15), [data?.routes, showAllRoutes]);
  const dataThrough = data
    ? new Date(new Date(data.period.currentEnd).getTime() - (days === 1 ? 0 : 1))
    : null;

  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("swaprank-theme", next); } catch { /* Theme still applies for this page view. */ }
  }

  return <main className="app-shell">
    <header className="topbar">
      <Link className="brand" href="/" aria-label="SwapRank home"><span className="brand-symbol"><i /><i /><i /></span><span>Swap<span>Rank</span></span></Link>
      <div className="top-actions"><nav aria-label="Primary navigation"><Link href="/">Leaderboard</Link><Link className="active" href="/analytics">Analytics</Link></nav><button className="theme-toggle" onClick={toggleTheme} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}><span className="theme-glyph" aria-hidden="true" /><b>{theme === "dark" ? "Light" : "Dark"}</b></button></div>
    </header>

    <section className="analytics-page">
      <header className="analytics-heading">
        <div><p className="eyebrow">Market data / protocol comparison</p><h1>DEX ANALYTICS</h1><p>Compare quote quality and reliability only where each DEX is eligible to serve the route.</p></div>
        <div className="analytics-freshness"><span>DATA THROUGH</span><strong>{dataThrough ? dataThrough.toLocaleString([], days === 1 ? { hour: "numeric", minute: "2-digit" } : { month: "short", day: "numeric" }) : "—"}</strong><small>{days === 1 ? "Rolling 24-hour window" : "Complete UTC days"}</small></div>
      </header>

      <section className="analytics-toolbar" aria-label="Analytics filters">
        <fieldset><legend>Period</legend><div className="segmented">{([1, 7, 30] as PeriodDays[]).map((value) => <button key={value} className={days === value ? "selected" : ""} onClick={() => setDays(value)}>{value === 1 ? "24 hours" : `${value} days`}</button>)}</div></fieldset>
        <fieldset><legend>Swap size</legend><div className="analytics-size-filter">{sizes.map((size) => <button key={size.id} className={amountId === size.id ? "selected" : ""} onClick={() => setAmountId(size.id)}>{size.label}</button>)}</div></fieldset>
      </section>

      {error && <div className="error-state"><b>Analytics unavailable</b><span>{error}</span></div>}
      {loading && !data && <div className="analytics-loading" role="status">Building eligibility-aware comparisons…</div>}

      {data && <div className={loading ? "analytics-content refreshing" : "analytics-content"}>
        <section className="analytics-summary-grid" aria-label="DEX comparison">
          {partners.map((item) => {
            const summary = data.summaries.find((entry) => entry.protocol === item.id);
            return <article className="analytics-summary-card" key={item.id} style={{ borderTopColor: item.color }}>
              <header><PartnerLogo id={item.id} /><div><span>{item.name}</span><small>{summary?.supportedRoutes ?? 0} supported routes</small></div><b className={summary?.change != null && summary.change < 0 ? "down" : "up"}>{delta(summary?.change ?? null)}</b></header>
              <strong>{percent(summary?.winRate ?? null, 1)}</strong><span>supported-route win rate</span>
              <dl><div><dt>Availability</dt><dd>{percent(summary?.availability ?? null, 1)}</dd></div><div><dt>Avg vs oracle</dt><dd>{bps(summary?.averageOracleGapBps ?? null)}</dd></div><div><dt>Eligible checks</dt><dd>{summary?.eligibleChecks.toLocaleString() ?? "—"}</dd></div></dl>
            </article>;
          })}
        </section>

        <section className="analytics-panel">
          <header><div><p className="eyebrow">Change over time</p><h2>Supported-route win rate</h2><p>Each DEX is measured only on checks for routes it supports. Missing data remains an empty gap.</p></div></header>
          <TimelineChart data={data.timeline} />
        </section>

        <section className="analytics-split">
          <div className="analytics-panel analytics-movers">
            <header><div><p className="eyebrow">Biggest changes</p><h2>Route movers</h2><p>Largest win-share movements versus the preceding equivalent period.</p></div></header>
            <div>{data.movers.length ? data.movers.map((mover) => {
              const item = partner(mover.protocol)!;
              return <Link href={`/routes/${encodeURIComponent(mover.routeId)}?size=${amountId}&days=${days}`} key={`${mover.routeId}-${mover.protocol}`}>
                <PartnerLogo id={mover.protocol} /><span><b>{mover.source.symbol} → {mover.destination.symbol}</b><small>{item.name}{mover.leaderChanged ? " · leadership changed" : ""}</small></span><strong className={mover.change < 0 ? "down" : "up"}>{delta(mover.change)}</strong>
              </Link>;
            }) : <div className="analytics-empty compact">No comparable prior-period data yet.</div>}</div>
          </div>

          <aside className="analytics-method">
            <p className="eyebrow">How to read this</p><h2>Coverage is not failure</h2><p>{data.definitions.winRate}</p><p>{data.definitions.availability}</p><div><b>N/A</b><span>The DEX does not support that route and receives no loss or availability penalty.</span></div>
          </aside>
        </section>

        <section className="analytics-panel analytics-routes">
          <header><div><p className="eyebrow">Route × DEX comparison</p><h2>Route leaderboard</h2><p>Ordered by the strongest route leader. Win share is distributed across valid quotes and includes sole-quote wins.</p></div><span>{data.routes.length} routes · {data.amount.label}</span></header>
          <div className="analytics-route-table-wrap"><table><thead><tr><th>Route</th><th>Leader</th>{partners.map((item) => <th key={item.id}>{item.shortName}</th>)}</tr></thead><tbody>{visibleRoutes.map((route) => <tr key={route.routeId}>
            <th><Link href={`/routes/${encodeURIComponent(route.routeId)}?size=${amountId}&days=${days}`}><b>{route.source.symbol} → {route.destination.symbol}</b><small>{chainLabel(route.source.chain)} → {chainLabel(route.destination.chain)}</small></Link></th>
            <td>{route.leader ? <span className="analytics-route-leader"><PartnerLogo id={route.leader} /><span><b>{partner(route.leader)?.name}</b><small>{percent(route.leaderWinShare, 1)}{route.leaderChanged ? " · changed" : ""}</small></span></span> : <span className="analytics-na">No quotes</span>}</td>
            {partners.map((item) => {
              const result = route.results.find((entry) => entry.protocol === item.id)!;
              return <td key={item.id} className={!result.supported ? "unsupported" : ""}>{result.supported ? <span className="analytics-heat" style={{ background: `color-mix(in srgb, ${item.color} ${Math.max(8, Math.round((result.winShare ?? 0) * 68))}%, var(--card))` }}><b>{percent(result.winShare, 0)}</b><small>{result.availability == null ? "Awaiting data" : `${percent(result.availability, 0)} available`}</small></span> : <span className="analytics-na">N/A</span>}</td>;
            })}
          </tr>)}</tbody></table></div>
          {data.routes.length > 15 && <button className="analytics-show-all" onClick={() => setShowAllRoutes((value) => !value)}>{showAllRoutes ? "Show top 15 routes" : `Show all ${data.routes.length} routes`}</button>}
        </section>
      </div>}
    </section>

    <footer><b>SwapRank</b><span><Link href="/">← Leaderboard</Link> · <a href="https://github.com/gerritsa/DEXQuoteTool">GitHub</a></span></footer>
  </main>;
}
