import { ensureBenchmarkSchema, getD1 } from "../../../db";

type SweepRow = {
  id: string;
  scheduledFor: string;
  status: "pending" | "running" | "complete" | "partial" | "failed";
  routeCount: number;
  jobCount: number;
  completedJobs: number;
  failedJobs: number;
  startedAt: string;
  completedAt: string | null;
  missingRoutesJson: string | null;
};

type ProtocolHealthRow = {
  protocol: string;
  attempts: number;
  successes: number;
  errors: number;
  latestResponseAt: string | null;
};

function parseMissingRoutes(value: string | null) {
  try {
    const parsed = value ? JSON.parse(value) : [];
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export async function GET() {
  try {
    await ensureBenchmarkSchema();
    const d1 = getD1();
    const latest = await d1.prepare(`
      SELECT id, scheduled_for AS scheduledFor, status, route_count AS routeCount,
        job_count AS jobCount, completed_jobs AS completedJobs, failed_jobs AS failedJobs,
        started_at AS startedAt, completed_at AS completedAt, missing_routes_json AS missingRoutesJson
      FROM collector_sweeps
      ORDER BY scheduled_for DESC
      LIMIT 1
    `).first<SweepRow>();
    const latestTerminal = await d1.prepare(`
      SELECT id, scheduled_for AS scheduledFor, status, route_count AS routeCount,
        job_count AS jobCount, completed_jobs AS completedJobs, failed_jobs AS failedJobs,
        started_at AS startedAt, completed_at AS completedAt, missing_routes_json AS missingRoutesJson
      FROM collector_sweeps
      WHERE status IN ('complete', 'partial', 'failed')
      ORDER BY scheduled_for DESC
      LIMIT 1
    `).first<SweepRow>();
    const quoteCutoff = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const partnerResult = await d1.prepare(`
      SELECT q.protocol AS protocol, COUNT(*) AS attempts,
        SUM(CASE WHEN q.status = 'quoted' THEN 1 ELSE 0 END) AS successes,
        SUM(CASE WHEN q.status = 'error' THEN 1 ELSE 0 END) AS errors,
        MAX(q.response_received_at) AS latestResponseAt
      FROM protocol_quotes q
      JOIN benchmark_runs r ON r.id = q.run_id
      WHERE r.initiated_at >= ?
      GROUP BY q.protocol
      ORDER BY q.protocol
    `).bind(quoteCutoff).all<ProtocolHealthRow>();

    const now = Date.now();
    const terminalAt = latestTerminal?.completedAt ?? latestTerminal?.scheduledFor;
    const minutesSinceTerminal = terminalAt ? Math.round((now - new Date(terminalAt).getTime()) / 60_000) : null;
    const latestAgeMinutes = latest ? Math.round((now - new Date(latest.scheduledFor).getTime()) / 60_000) : null;
    const missingRoutes = parseMissingRoutes(latest?.missingRoutesJson ?? null);
    const warnings: string[] = [];
    let status: "healthy" | "degraded" | "stale" | "initializing" = "healthy";

    if (!latest) {
      status = "initializing";
      warnings.push("No collector sweep has been recorded yet.");
    } else if (minutesSinceTerminal == null || minutesSinceTerminal > 75) {
      status = "stale";
      warnings.push("No terminal sweep has completed within 75 minutes.");
    }
    if (latest && ["partial", "failed"].includes(latest.status)) {
      if (status === "healthy") status = "degraded";
      warnings.push(`Latest sweep finished with status ${latest.status}.`);
    }
    if (latest?.status === "running" && latestAgeMinutes != null && latestAgeMinutes > 45) {
      if (status === "healthy") status = "degraded";
      warnings.push("Latest sweep has been running for more than 45 minutes.");
    }
    if (missingRoutes.length) {
      if (status === "healthy") status = "degraded";
      warnings.push(`${missingRoutes.length} fixed route${missingRoutes.length === 1 ? " is" : "s are"} temporarily unavailable.`);
    }

    const partners = partnerResult.results.map((partner) => {
      const attempts = Number(partner.attempts);
      const errors = Number(partner.errors);
      const errorRate = attempts ? errors / attempts : 0;
      if (attempts >= 10 && errorRate > 0.2) {
        if (status === "healthy") status = "degraded";
        warnings.push(`${partner.protocol} quote errors exceeded 20% over the last two hours.`);
      }
      return {
        protocol: partner.protocol,
        attempts,
        successes: Number(partner.successes),
        errors,
        errorRate,
        latestResponseAt: partner.latestResponseAt,
      };
    });

    return Response.json({
      status,
      checkedAt: new Date(now).toISOString(),
      schedule: "every 30 minutes",
      latestSweep: latest ? {
        id: latest.id,
        scheduledFor: latest.scheduledFor,
        status: latest.status,
        routeCount: Number(latest.routeCount),
        jobCount: Number(latest.jobCount),
        completedJobs: Number(latest.completedJobs),
        failedJobs: Number(latest.failedJobs),
        completedAt: latest.completedAt,
        missingRoutes,
      } : null,
      minutesSinceTerminalSweep: minutesSinceTerminal,
      partners,
      warnings,
    }, {
      status: status === "healthy" ? 200 : 503,
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return Response.json({
      status: "unhealthy",
      checkedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : "Health check failed",
    }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
