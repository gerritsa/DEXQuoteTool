/** Cloudflare Worker entry point for the DEX Quote Tool. */
import handler from "vinext/server/app-router-entry";
import type { CollectorBundle } from "../lib/collector";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  ARCHIVE: R2Bucket;
  BENCHMARK_QUEUE: Queue<CollectorBundle>;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handler.fetch(request, env, ctx);
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    const task: Promise<unknown> = (async () => {
      const { enqueueScheduledSweep, runDailyMaintenance } = await import("../lib/collector");
      if (controller.cron === "15 0 * * *") {
        return runDailyMaintenance(controller.scheduledTime, env);
      }
      return enqueueScheduledSweep(controller.scheduledTime, env);
    })();
    ctx.waitUntil(task);
  },

  async queue(batch: MessageBatch<CollectorBundle>, env: Env, ctx: ExecutionContext) {
    void ctx;
    const { processCollectorBundle } = await import("../lib/collector");
    await Promise.all(batch.messages.map(async (message) => {
      try {
        await processCollectorBundle(message.body, env);
        message.ack();
      } catch {
        message.retry({ delaySeconds: 60 });
      }
    }));
  },
};

export default worker;
