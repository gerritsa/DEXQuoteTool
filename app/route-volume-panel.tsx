"use client";

import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import type { PartnerId } from "./dashboard-query";
import type { RouteVolumeResponse, VolumeDays } from "../lib/volume/model";

type Provider = { id: PartnerId; name: string; cellName: string; color: string };
type Selection = { bucket: number; protocol: PartnerId; x: number; y: number };
const usd = (value: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 }).format(value);
const fullUsd = (value: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value);
const period = (days: VolumeDays) => days === 1 ? "Last 24 hours" : `Last ${days} days`;

export default function RouteVolumePanel({ routeId, routeLabel, days, onDaysChange, providers, supportedProtocols, volume30DaysEnabled, refreshVersion, now }: {
  routeId: string; routeLabel: string; days: VolumeDays; onDaysChange: (days: VolumeDays) => void;
  providers: Provider[]; supportedProtocols: PartnerId[]; refreshVersion: number; now: number;
  volume30DaysEnabled: boolean;
}) {
  const [response, setResponse] = useState<RouteVolumeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [metric, setMetric] = useState<"volumeUsd" | "swapCount">("volumeUsd");
  const root = useRef<HTMLElement>(null);
  const tooltipId = useId();
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true); setError(null); setSelection(null);
      try {
        const result = await fetch(`/api/route-volume?${new URLSearchParams({ routeId, days: String(days), schema: "2" })}`, { signal: controller.signal });
        const value = await result.json() as RouteVolumeResponse & { error?: string };
        if (!result.ok) throw new Error(value.error ?? "Trading volume is unavailable");
        if (!controller.signal.aborted) setResponse(value);
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Trading volume is unavailable");
      } finally { if (!controller.signal.aborted) setLoading(false); }
    }, 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [routeId, days, refreshVersion]);
  const data = response?.routeId === routeId && response.days === days ? response : null;
  const maximum = Math.max(0, ...data?.buckets.map((bucket) => bucket[metric]) ?? []);
  const scale = maximum ? metric === "swapCount" ? Math.max(2, Math.ceil(maximum * 1.15 / 2) * 2) : maximum * 1.15 : 1;
  const metricLabel = metric === "volumeUsd" ? "USD volume" : "Successful swaps";
  const formatMetric = (value: number) => metric === "volumeUsd" ? usd(value) : Math.round(value).toLocaleString();
  const selectedBucket = selection ? data?.buckets[selection.bucket] : null;
  const selectedProvider = selectedBucket?.providers.find((provider) => provider.protocol === selection?.protocol);
  const providerName = providers.find((provider) => provider.id === selection?.protocol)?.cellName;
  const coverage = data?.coverage.find((provider) => provider.protocol === selection?.protocol);
  const stale = !!data?.endAt && now - Date.parse(data.endAt) > 2 * 3_600_000;

  function inspect(element: HTMLElement, bucket: number, protocol: PartnerId) {
    const bounds = element.getBoundingClientRect();
    const container = root.current!.getBoundingClientRect();
    setSelection({ bucket, protocol, x: Math.max(8, Math.min(container.width - 258, bounds.left - container.left - 70)), y: bounds.top - container.top - 145 });
  }

  return <section ref={root} className="trend-card route-volume-panel" aria-labelledby="volume-title" aria-busy={loading}>
    <header className="trend-header">
      <div><p className="eyebrow">Market activity · This route</p><h2 id="volume-title">Observed trading activity</h2><p>Provider volume and successful customer swaps for the selected route.</p></div>
      <div className="trend-controls"><fieldset><legend>Volume period</legend><div className="segmented light">{([1, 7, 30] as const).map((value) => <button key={value} className={days === value ? "selected" : ""} disabled={value === 30 && !volume30DaysEnabled} title={value === 30 && !volume30DaysEnabled ? "Paused while recent volume coverage catches up" : undefined} onClick={() => onDaysChange(value)} aria-pressed={days === value}>{value === 1 ? "24 hours" : `${value} days`}</button>)}</div></fieldset></div>
    </header>
    {error ? <div className="trend-empty" role="status"><b>Couldn’t load trading activity</b><span>Please try again shortly.</span></div>
      : !data ? <div className="trend-empty" role="status"><b>Loading trading volume…</b><span>Reading this route’s published totals.</span></div>
      : <div className="volume-content">
        {data.status === "unavailable" ? <div className="trend-empty" role="status"><b>Volume history is being collected</b><span>Waiting for matching provider coverage on this route.</span></div> : <>
        <div className="volume-summary">
          <div><span>Combined observed volume</span><strong>{usd(data.volumeUsd)}</strong></div>
          <div><span>Successful swaps</span><strong>{(data.swapCount + data.unpricedSwaps).toLocaleString()}</strong></div>
          <div className="volume-freshness"><span className={`volume-coverage-status ${data.status}`}>{data.status === "complete" ? "Complete coverage" : data.status === "partial" ? "Partial coverage" : "Awaiting coverage"}{stale ? " · Stale" : ""}</span><strong>{period(days)}</strong><small>{data.comparison.hours} of {data.comparison.expectedHours} hours available</small>{data.startAt && data.endAt && <small className="volume-covered-dates">Covered interval<br /><time dateTime={data.startAt}>{new Date(data.startAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</time><span> → </span><time dateTime={data.endAt}>{new Date(data.endAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</time></small>}</div>
        </div>
        {data.status === "partial" && <p className="volume-notice" role="status">These totals cover {data.comparison.hours} {data.comparison.hours === 1 ? "hour" : "hours"}, rather than the full selected period. Every participating provider uses the covered interval shown above.</p>}
        </>}
        {data.status !== "unavailable" && <>
          <div className="volume-chart-toolbar"><div><h3>{metric === "volumeUsd" ? "Trading volume by size" : "Successful swaps by size"}</h3><p>Successful swaps grouped by historical USD input value.</p></div><div className="segmented" role="group" aria-label="Chart measure">{(["volumeUsd", "swapCount"] as const).map((value) => <button key={value} type="button" className={metric === value ? "selected" : ""} aria-pressed={metric === value} onClick={() => { setSelection(null); setMetric(value); }}>{value === "volumeUsd" ? "USD volume" : "Swap count"}</button>)}</div></div>
          <div className="volume-chart-legend" aria-label="Chart providers">{providers.map((provider) => <span key={provider.id}><i style={{ background: provider.color }} />{provider.cellName}</span>)}</div>
          {maximum > 0 ? <div className="volume-chart-scroll"><div className="volume-chart" aria-label={`Stacked ${metricLabel.toLowerCase()} by USD input size`}>
            <div className="volume-axis-label">{metricLabel}</div>
            <div className="volume-y-axis" aria-hidden="true"><span>{formatMetric(scale)}</span><span>{formatMetric(scale / 2)}</span><span>{metric === "volumeUsd" ? "$0" : "0"}</span></div>
            <div className="volume-columns">{data.buckets.map((bucket, index) => <div className="volume-column" key={bucket.id}>
              <div className="volume-stack-area"><div className="volume-total" style={{ bottom: `${bucket[metric] / scale * 100}%` }}>{formatMetric(bucket[metric])}</div>
                <div className="volume-stack">{providers.map((provider) => {
                  const value = bucket.providers.find((entry) => entry.protocol === provider.id)!;
                  if (!value[metric]) return null;
                  return <button key={provider.id} type="button" className="volume-segment" style={{ height: `${value[metric] / scale * 100}%`, "--volume-color": provider.color } as CSSProperties}
                    aria-label={`${provider.cellName}, ${bucket.label}: ${fullUsd(value.volumeUsd)}, ${value.swapCount} successful swaps, ${period(days)}`}
                    aria-describedby={selection?.bucket === index && selection.protocol === provider.id ? tooltipId : undefined}
                    onMouseEnter={(event) => inspect(event.currentTarget, index, provider.id)} onMouseLeave={() => setSelection(null)}
                    onFocus={(event) => inspect(event.currentTarget, index, provider.id)} onBlur={() => setSelection(null)}
                    onClick={(event) => inspect(event.currentTarget, index, provider.id)} onKeyDown={(event) => { if (event.key === "Escape") setSelection(null); }} />;
                })}</div>
              </div>
              <div className="volume-bucket-label">{bucket.label}</div>
            </div>)}</div>
            <div className="volume-x-axis">Input size (USD)</div>
            <div className="volume-benchmark-heading"><b>Best benchmark quote</b><span>Quote checks at each bucket’s upper limit · Separate from executed swaps</span></div>
            <div className="volume-columns volume-benchmark-grid">{data.buckets.map((bucket) => <div className="volume-bucket-leader" key={bucket.id}>{bucket.id === "overflow" ? <span>No benchmark</span> : bucket.leaders.length ? <>
                <b>{bucket.leaders.map((id) => providers.find((provider) => provider.id === id)?.cellName).join(" / ")}</b>
                <strong>{Math.round((bucket.winRate ?? 0) * 100)}% wins</strong><small>{bucket.samples} checks</small>
              </> : <span>No quote history</span>}</div>)}</div>
          </div></div> : <div className="volume-zero">No swaps with a USD valuation in the covered interval.</div>}
          {maximum > 0 && <p className="volume-scroll-hint">Swipe across to compare all eight size buckets.</p>}
          <details className="volume-data-table"><summary>View volume and swap counts by provider</summary><div className="volume-table-scroll"><table>
            <caption>{routeLabel} · {period(days)}</caption><thead><tr><th>Input size</th>{providers.map((provider) => <th key={provider.id}>{provider.cellName}</th>)}</tr></thead>
            <tbody>{data.buckets.map((bucket) => <tr key={bucket.id}><th scope="row">{bucket.label}</th>{providers.map((provider) => {
              const value = bucket.providers.find((entry) => entry.protocol === provider.id)!;
              return <td key={provider.id}>{!supportedProtocols.includes(provider.id) && !value.swapCount ? "Not currently supported" : value.available ? <><b>{fullUsd(value.volumeUsd)}</b><span>{value.swapCount.toLocaleString()} swaps</span></> : "Unavailable"}</td>;
            })}</tr>)}</tbody></table></div></details>
        </>}
        <details className="volume-provider-details"><summary>Provider coverage and sources</summary><div className="volume-coverage" aria-label="Provider volume coverage">{providers.map((provider) => {
          const item = data.coverage.find((entry) => entry.protocol === provider.id)!;
          const supported = supportedProtocols.includes(provider.id);
          const historicalActivity = data.buckets.some((bucket) => bucket.providers.some((entry) => entry.protocol === provider.id && entry.swapCount > 0));
          const status = !supported ? historicalActivity ? "Historical activity" : "Not currently supported"
            : item.status === "complete" ? "Complete" : item.hours ? `${item.hours} of ${item.expectedHours} hours` : "Awaiting coverage";
          return <span key={provider.id}><i style={{ background: provider.color }} /><b>{provider.cellName}</b><small>{status}</small><small>{item.scope}</small>{item.error && <small>{item.error}</small>}</span>;
        })}</div></details>
        {data.unpricedSwaps > 0 && <p className="volume-notice">{data.unpricedSwaps.toLocaleString()} successful swaps have no usable historical USD valuation and are outside the size buckets.</p>}
        {data.status !== "unavailable" && <p className="volume-method">Every participating provider uses the same completed time interval shown above, including the benchmark quote leaders. Successful swaps use each provider’s recorded swap time. Streaming and DCA chunks count as one customer swap. NEAR coverage is external 1Click swaps; provider volumes may overlap through underlying execution.</p>}
      </div>}
    {selection && selectedBucket && selectedProvider && <div id={tooltipId} role="tooltip" className="volume-tooltip" style={{ left: selection.x, top: Math.max(90, selection.y) }}>
      <b>{providerName} · {selectedBucket.label}</b><span>{routeLabel}</span><small>{period(days)}</small>
      <div><span>Volume</span><strong>{fullUsd(selectedProvider.volumeUsd)}</strong></div><div><span>Swaps</span><strong>{selectedProvider.swapCount.toLocaleString()}</strong></div>
      {coverage?.status !== "complete" && <small>{coverage?.hours}/{coverage?.expectedHours} hours collected</small>}
    </div>}
  </section>;
}
