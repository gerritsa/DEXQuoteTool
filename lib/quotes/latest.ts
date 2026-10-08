import { bestOutputMode } from "./protocols";

export type CompletedQuoteBatch = { runId: number; pairId: string; amountId: string; initiatedAt: string };

export async function completedQuoteBatch(d1: D1Database, routeId: string | null, amountId: string | null,
  requestedRunId: number | null = null, requireOracle = false) {
  const conditions = ["r.completed_at IS NOT NULL", "r.status IN ('complete', 'partial')"];
  const args: Array<string | number> = [];
  if (requestedRunId) { conditions.push("r.id = ?"); args.push(requestedRunId); }
  if (routeId) { conditions.push(`${requestedRunId ? "r" : "p"}.pair_id = ?`); args.push(routeId); }
  if (amountId) { conditions.push(`${requestedRunId ? "r" : "p"}.amount_id = ?`); args.push(amountId); }
  if (!requestedRunId) { conditions.push("p.mode = ?"); args.push(bestOutputMode); }
  if (requireOracle) { conditions.push("r.mode = ?", "r.oracle_captured_at IS NOT NULL"); args.push(bestOutputMode); }
  return d1.prepare(`SELECT r.id AS runId, r.pair_id AS pairId, r.amount_id AS amountId, r.initiated_at AS initiatedAt
    FROM ${requestedRunId ? "benchmark_runs r" : "latest_quote_payloads p JOIN benchmark_runs r ON r.id = p.run_id"}
    WHERE ${conditions.join(" AND ")} ORDER BY r.initiated_at DESC, r.id DESC LIMIT 1`)
    .bind(...args).first<CompletedQuoteBatch>();
}

export async function latestQuoteRevision(d1: D1Database) {
  // Read the small, fixed-size latest table through a covering index, without
  // accessing request/response payloads. Hash every entry so late completions
  // and retries invalidate the cache even when the largest run ID is unchanged.
  const row = await d1.prepare(`SELECT GROUP_CONCAT(entry, '|') AS fingerprint FROM (
    SELECT run_id || ':' || updated_at AS entry FROM latest_quote_payloads
    WHERE mode = ? ORDER BY run_id, updated_at
  )`).bind(bestOutputMode).first<{ fingerprint: string | null }>();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(row?.fingerprint ?? ""));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
