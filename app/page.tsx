"use client";

import { useMemo, useState } from "react";

type Protocol = "THORChain" | "Chainflip" | "NEAR Intents" | "Maya";
type Mode = "standard" | "optimized";

type RangeResult = {
  range: string;
  sample: string;
  standardWinner: Protocol;
  standardEdge: number;
  optimizedWinner: Protocol;
  optimizedGain: number;
  eta: string;
  confidence: "Dominant" | "Mixed";
};

const protocols: Array<{
  name: Protocol;
  mark: string;
  color: string;
  status: string;
  ready: boolean;
}> = [
  { name: "THORChain", mark: "T", color: "#17b897", status: "Public API ready", ready: true },
  { name: "Chainflip", mark: "C", color: "#ff4fd8", status: "SDK ready", ready: true },
  { name: "NEAR Intents", mark: "N", color: "#171717", status: "Key required", ready: false },
  { name: "Maya", mark: "M", color: "#ef6a38", status: "Public API ready", ready: true },
];

const pairs = [
  { id: "btc-eth", from: "BTC", to: "ETH", route: "Bitcoin → Ethereum", outputPrice: 3250 },
  { id: "eth-btc", from: "ETH", to: "BTC", route: "Ethereum → Bitcoin", outputPrice: 96400 },
  { id: "eth-usdc", from: "ETH", to: "USDC", route: "Ethereum → Ethereum", outputPrice: 1 },
];

const results: RangeResult[] = [
  { range: "$1 – <$100", sample: "$10 · $32 · $99", standardWinner: "NEAR Intents", standardEdge: 0.18, optimizedWinner: "NEAR Intents", optimizedGain: 0.00, eta: "~1m", confidence: "Dominant" },
  { range: "$100 – <$1K", sample: "$100 · $316 · $999", standardWinner: "Chainflip", standardEdge: 0.12, optimizedWinner: "Chainflip", optimizedGain: 0.08, eta: "~2m", confidence: "Mixed" },
  { range: "$1K – <$10K", sample: "$1K · $3.2K · $9.9K", standardWinner: "THORChain", standardEdge: 0.24, optimizedWinner: "THORChain", optimizedGain: 0.31, eta: "~4m", confidence: "Dominant" },
  { range: "$10K – <$50K", sample: "$10K · $22K · $49K", standardWinner: "THORChain", standardEdge: 0.36, optimizedWinner: "Chainflip", optimizedGain: 0.42, eta: "~7m", confidence: "Mixed" },
  { range: "$50K – <$100K", sample: "$50K · $71K · $99K", standardWinner: "Chainflip", standardEdge: 0.28, optimizedWinner: "Chainflip", optimizedGain: 0.61, eta: "~9m", confidence: "Dominant" },
  { range: "$100K – <$200K", sample: "$100K · $141K · $199K", standardWinner: "Maya", standardEdge: 0.44, optimizedWinner: "THORChain", optimizedGain: 0.88, eta: "~12m", confidence: "Mixed" },
  { range: "$200K – <$500K", sample: "$200K · $316K · $499K", standardWinner: "Maya", standardEdge: 0.72, optimizedWinner: "THORChain", optimizedGain: 1.14, eta: "~18m", confidence: "Mixed" },
  { range: "$500K – $1M", sample: "$500K · $707K · $1M", standardWinner: "THORChain", standardEdge: 1.08, optimizedWinner: "THORChain", optimizedGain: 1.63, eta: "~26m", confidence: "Dominant" },
];

const protocolAdjustment: Record<Protocol, number> = {
  THORChain: 0.9982,
  Chainflip: 0.9974,
  "NEAR Intents": 0.9968,
  Maya: 0.9959,
};

function ProtocolName({ name }: { name: Protocol }) {
  const protocol = protocols.find((item) => item.name === name)!;
  return (
    <span className="protocol-name">
      <span className="protocol-mark" style={{ background: protocol.color }} aria-hidden="true">{protocol.mark}</span>
      {name}
    </span>
  );
}

function formatOutput(value: number, symbol: string) {
  const digits = symbol === "USDC" ? 2 : value >= 100 ? 3 : value >= 1 ? 5 : 7;
  return `${value.toLocaleString("en-US", { maximumFractionDigits: digits })} ${symbol}`;
}

export default function Home() {
  const [pairId, setPairId] = useState(pairs[0].id);
  const [mode, setMode] = useState<Mode>("standard");
  const [selectedIndex, setSelectedIndex] = useState(3);
  const [capturedAt, setCapturedAt] = useState("Preview dataset");
  const [refreshing, setRefreshing] = useState(false);

  const pair = pairs.find((item) => item.id === pairId)!;
  const selected = results[selectedIndex];
  const winner = mode === "standard" ? selected.standardWinner : selected.optimizedWinner;

  const quoteCards = useMemo(() => {
    const usdMidpoints = [32, 316, 3162, 22361, 70711, 141421, 316228, 707107];
    const baseOutput = usdMidpoints[selectedIndex] / pair.outputPrice;
    return protocols.map((protocol, protocolIndex) => {
      const isWinner = protocol.name === winner;
      const modeLift = mode === "optimized" && ["THORChain", "Chainflip", "Maya"].includes(protocol.name)
        ? selected.optimizedGain / 100
        : 0;
      const variation = 1 - protocolIndex * 0.00045 - selectedIndex * protocolIndex * 0.00007;
      const normalized = isWinner
        ? 1
        : protocolAdjustment[protocol.name] * variation;
      return {
        ...protocol,
        isWinner,
        output: baseOutput * normalized * (1 + modeLift),
        fee: (0.08 + protocolIndex * 0.07 + selectedIndex * 0.03).toFixed(2),
        duration: mode === "optimized" && ["THORChain", "Chainflip", "Maya"].includes(protocol.name)
          ? selected.eta
          : protocolIndex === 2 ? "~1m" : `~${2 + protocolIndex}m`,
        strategy: mode === "optimized"
          ? protocol.name === "Chainflip" ? "DCA" : protocol.name === "NEAR Intents" ? "Solver quote" : "Streaming"
          : protocol.name === "NEAR Intents" ? "Solver quote" : "Single swap",
      };
    }).sort((a, b) => b.output - a.output);
  }, [mode, pair.outputPrice, selected, selectedIndex, winner]);

  function refreshPreview() {
    setRefreshing(true);
    window.setTimeout(() => {
      setCapturedAt(`Preview refreshed ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`);
      setRefreshing(false);
    }, 650);
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="QuoteTool home">
          <span className="brand-symbol" aria-hidden="true"><i /><i /><i /></span>
          <span>Quote<span>Tool</span></span>
        </a>
        <nav aria-label="Primary navigation">
          <a className="active" href="#overview">Overview</a>
          <a href="#methodology">Methodology</a>
          <a href="#coverage">Coverage</a>
        </nav>
        <div className="preview-pill"><span /> Preview mode</div>
      </header>

      <section className="hero" id="top">
        <div>
          <p className="eyebrow">Cross-chain execution intelligence</p>
          <h1>See where every trade<br />gets the <em>best execution.</em></h1>
          <p className="hero-copy">Compare synchronized quotes across four cross-chain protocols, from a $1 swap to a $1M order.</p>
        </div>
        <div className="hero-aside" aria-label="Benchmark status">
          <span>Benchmark coverage</span>
          <strong>4 <small>protocols</small></strong>
          <div className="coverage-bar"><i /><i /><i /><i className="pending" /></div>
          <p>NEAR goes live when your Distribution Channel key is added.</p>
        </div>
      </section>

      <section className="control-panel" aria-label="Benchmark controls">
        <label>
          <span>Trading pair</span>
          <select value={pairId} onChange={(event) => setPairId(event.target.value)}>
            {pairs.map((item) => <option key={item.id} value={item.id}>{item.from} → {item.to} · {item.route}</option>)}
          </select>
        </label>
        <fieldset>
          <legend>Execution view</legend>
          <div className="segmented-control">
            <button className={mode === "standard" ? "selected" : ""} onClick={() => setMode("standard")} type="button">Standard</button>
            <button className={mode === "optimized" ? "selected" : ""} onClick={() => setMode("optimized")} type="button">Best output</button>
          </div>
        </fieldset>
        <div className="capture-control">
          <span>{capturedAt}</span>
          <button type="button" onClick={refreshPreview} disabled={refreshing}>{refreshing ? "Refreshing…" : "Refresh preview"}</button>
        </div>
      </section>

      <section className="summary-grid" id="overview">
        <article className="summary-card primary">
          <p>Standard execution leader</p>
          <ProtocolName name="THORChain" />
          <strong>3 of 8 <span>ranges won</span></strong>
          <small>Fast, single-swap routes only</small>
        </article>
        <article className="summary-card">
          <p>Best-output leader</p>
          <ProtocolName name="THORChain" />
          <strong>4 of 8 <span>ranges won</span></strong>
          <small>Streaming and DCA included</small>
        </article>
        <article className="summary-card">
          <p>Largest optimization gain</p>
          <strong className="metric">+1.63%</strong>
          <small>At $500K–$1M · ~26m execution</small>
        </article>
        <article className="summary-card">
          <p>Range confidence</p>
          <strong className="metric">4 / 8</strong>
          <small>Four ranges need crossover sampling</small>
        </article>
      </section>

      <section className="comparison-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Range map</p>
            <h2>Winner by trade size</h2>
          </div>
          <p>Three logarithmic samples per range. Select a row to inspect the quote stack.</p>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>USD range</th>
                <th>Standard winner</th>
                <th>Edge</th>
                <th>Best-output winner</th>
                <th>Optimization</th>
                <th>Est. duration</th>
                <th>Confidence</th>
              </tr>
            </thead>
            <tbody>
              {results.map((row, index) => (
                <tr key={row.range} className={selectedIndex === index ? "selected-row" : ""} onClick={() => setSelectedIndex(index)} tabIndex={0} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") setSelectedIndex(index); }}>
                  <td><strong>{row.range}</strong><small>{row.sample}</small></td>
                  <td><ProtocolName name={row.standardWinner} /></td>
                  <td className="positive">+{row.standardEdge.toFixed(2)}%</td>
                  <td><ProtocolName name={row.optimizedWinner} /></td>
                  <td className="positive">+{row.optimizedGain.toFixed(2)}%</td>
                  <td>{row.eta}</td>
                  <td><span className={`confidence ${row.confidence.toLowerCase()}`}>{row.confidence}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="quote-inspector">
        <div className="section-heading compact">
          <div>
            <p className="eyebrow">Quote stack · {selected.range}</p>
            <h2>{mode === "standard" ? "Standard execution" : "Best-output execution"}</h2>
          </div>
          <span className="sample-note">Representative midpoint · synchronized batch</span>
        </div>
        <div className="quote-grid">
          {quoteCards.map((quote, index) => (
            <article className={`quote-card ${quote.isWinner ? "winner" : ""}`} key={quote.name}>
              <div className="quote-rank">{index + 1}</div>
              <ProtocolName name={quote.name} />
              {quote.isWinner && <span className="winner-label">Best quote</span>}
              <strong>{formatOutput(quote.output, pair.to)}</strong>
              <div className="quote-meta"><span>{quote.strategy}</span><span>{quote.duration}</span><span>{quote.fee}% quoted cost</span></div>
            </article>
          ))}
        </div>
        <p className="data-note">Illustrative preview values—not live market quotes. Raw responses, request timestamps, and quote expiries will be retained once live collection is enabled.</p>
      </section>

      <section className="mode-explainer" id="methodology">
        <div>
          <p className="eyebrow">Why two views?</p>
          <h2>Price and time are separate decisions.</h2>
        </div>
        <article>
          <span>01</span>
          <h3>Standard</h3>
          <p>Compares single-swap or regular routes. This is the clearest answer to “who wins now?”</p>
        </article>
        <article>
          <span>02</span>
          <h3>Best output</h3>
          <p>Allows native route optimization: streaming on THORChain and Maya, DCA on Chainflip, and the best NEAR solver quote.</p>
        </article>
        <article>
          <span>03</span>
          <h3>No hidden score</h3>
          <p>Output and duration stay visible. The tool never invents an opaque price-versus-speed ranking.</p>
        </article>
      </section>

      <section className="protocol-status" id="coverage">
        <div className="section-heading compact">
          <div><p className="eyebrow">Integration status</p><h2>Protocol coverage</h2></div>
        </div>
        <div className="status-list">
          {protocols.map((protocol) => (
            <div key={protocol.name}>
              <ProtocolName name={protocol.name} />
              <span className={protocol.ready ? "ready" : "waiting"}>{protocol.status}</span>
            </div>
          ))}
        </div>
      </section>

      <footer>
        <span>QuoteTool</span>
        <p>Comparable inputs. Transparent execution. Auditable winners.</p>
        <a href="#top">Back to top ↑</a>
      </footer>
    </main>
  );
}
