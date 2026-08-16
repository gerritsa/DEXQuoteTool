import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { benchmarkRuns, protocolQuotes } from "../../../db/schema";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const routeId = url.searchParams.get("routeId")?.trim();
    const rangeId = url.searchParams.get("rangeId")?.trim();
    if (!routeId || !rangeId) return Response.json({ error: "routeId and rangeId are required" }, { status: 400 });

    const db = getDb();
    const [run] = await db.select().from(benchmarkRuns)
      .where(and(eq(benchmarkRuns.pairId, routeId), eq(benchmarkRuns.rangeId, rangeId)))
      .orderBy(desc(benchmarkRuns.createdAt), desc(benchmarkRuns.id)).limit(1);
    if (!run) return Response.json({ run: null, quotes: [] });

    const quotes = await db.select().from(protocolQuotes)
      .where(eq(protocolQuotes.runId, run.id))
      .orderBy(protocolQuotes.requestStartedAt, protocolQuotes.id);
    return Response.json({ run, quotes }, { headers: { "cache-control": "private, max-age=15" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Quote history unavailable";
    if (message.includes("no such table") || message.includes("no such column")) {
      return Response.json({ run: null, quotes: [], migrationPending: true });
    }
    return Response.json({ error: message }, { status: 500 });
  }
}
