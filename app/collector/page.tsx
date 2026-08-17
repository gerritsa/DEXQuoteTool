"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { quoteSizes } from "../../lib/quotes/sizes";

type CollectorRoute = { id: string };
type CollectorStatus = "idle" | "loading" | "running" | "complete" | "skipped" | "failed";

const lockKey = "quote-tool-overnight-sweep";
const lockDurationMs = 30 * 60 * 1000;
const concurrency = 8;
const modes = ["standard", "optimized"] as const;

export default function CollectorPage() {
  const [status, setStatus] = useState<CollectorStatus>("idle");
  const [total, setTotal] = useState(0);
  const [completed, setCompleted] = useState(0);
  const [failed, setFailed] = useState(0);
  const [message, setMessage] = useState("Ready to collect one synchronized quote batch for every fixed route and size.");
  const autoStarted = useRef(false);

  const runSweep = useCallback(async () => {
    const now = Date.now();
    const existingLock = Number(window.localStorage.getItem(lockKey) ?? 0);
    if (existingLock && now - existingLock < lockDurationMs) {
      setStatus("skipped");
      setMessage("Sweep already running in another collector tab.");
      return;
    }

    window.localStorage.setItem(lockKey, String(now));
    setStatus("loading");
    setCompleted(0);
    setFailed(0);
    setMessage("Loading the fixed route set…");

    try {
      const routeResponse = await fetch("/api/routes");
      const routePayload = await routeResponse.json() as { routes?: CollectorRoute[]; error?: string };
      if (!routeResponse.ok || !routePayload.routes) throw new Error(routePayload.error ?? "Route catalog unavailable");

      const jobs = routePayload.routes.flatMap((route) => quoteSizes.flatMap((size) => modes.map((mode) => ({ routeId: route.id, amountId: size.id, mode }))));
      setTotal(jobs.length);
      setStatus("running");
      setMessage(`Collecting ${jobs.length} route-and-size batches with ${concurrency} parallel workers…`);

      let nextJob = 0;
      let finishedJobs = 0;
      let failedJobs = 0;
      const worker = async () => {
        while (nextJob < jobs.length) {
          const job = jobs[nextJob++];
          try {
            const response = await fetch("/api/runs", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(job),
            });
            if (!response.ok) failedJobs += 1;
          } catch {
            failedJobs += 1;
          } finally {
            finishedJobs += 1;
            setCompleted(finishedJobs);
            setFailed(failedJobs);
          }
        }
      };

      await Promise.all(Array.from({ length: concurrency }, () => worker()));
      setStatus(failedJobs ? "failed" : "complete");
      setMessage(failedJobs ? `Sweep complete with ${failedJobs} failed batches.` : "Sweep complete. All route-and-size batches were stored.");
    } catch (error) {
      setStatus("failed");
      setMessage(error instanceof Error ? error.message : "Sweep failed");
    } finally {
      window.localStorage.removeItem(lockKey);
    }
  }, []);

  useEffect(() => {
    if (autoStarted.current || new URLSearchParams(window.location.search).get("run") !== "1") return;
    autoStarted.current = true;
    void runSweep();
  }, [runSweep]);

  const percent = total ? Math.round((completed / total) * 100) : 0;

  return <main className="collector-shell">
    <section className="collector-card">
      <p className="eyebrow">QuoteTool overnight collector</p>
      <h1>{status === "complete" ? "Sweep complete" : status === "skipped" ? "Sweep already running" : status === "failed" ? "Sweep finished with errors" : "Full quote sweep"}</h1>
      <p>{message}</p>
      <div className="collector-progress" aria-label={`${percent}% complete`}><i style={{ width: `${percent}%` }} /></div>
      <dl><div><dt>Progress</dt><dd>{completed} / {total || quoteSizes.length * modes.length * 30}</dd></div><div><dt>Modes</dt><dd>Instant + Streaming/DCA</dd></div><div><dt>Failed batches</dt><dd>{failed}</dd></div><div><dt>Parallel workers</dt><dd>{concurrency}</dd></div></dl>
      <button className="run-button" onClick={runSweep} disabled={status === "loading" || status === "running"}>{status === "loading" || status === "running" ? "Sweep running…" : "Run full sweep"}</button>
    </section>
  </main>;
}
