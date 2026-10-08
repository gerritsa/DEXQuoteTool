/** Cloudflare Worker entry point for SwapRank. */
import handler from "vinext/server/app-router-entry";
import type { CollectorBundle } from "../lib/collector";
import type { VolumeJob } from "../lib/volume/collector";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  ARCHIVE: R2Bucket;
  BENCHMARK_QUEUE: Queue<CollectorBundle>;
  VOLUME_QUEUE?: Queue<VolumeJob>;
  VOLUME_COLLECTION_ENABLED?: string;
  VOLUME_DAILY_PAGE_LIMIT?: string;
  VOLUME_LIVE_PAGE_RESERVE?: string;
  VOLUME_LIVE_CATCHUP_DAY?: string;
  VOLUME_LIVE_CATCHUP_PAGES?: string;
  VOLUME_30D_ENABLED?: string;
  NEAR_EXPLORER_API_KEY?: string;
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
        await runDailyMaintenance(controller.scheduledTime, env);
        const { pruneVolume } = await import("../lib/volume/collector");
        return pruneVolume(controller.scheduledTime, env);
      }
      if (controller.cron === "10,40 * * * *") {
        const { enqueueVolumeCollection } = await import("../lib/volume/collector");
        return enqueueVolumeCollection(controller.scheduledTime, env);
      }
      return enqueueScheduledSweep(controller.scheduledTime, env);
    })();
    ctx.waitUntil(task);
  },

  async queue(batch: MessageBatch<CollectorBundle | VolumeJob>, env: Env, ctx: ExecutionContext) {
    void ctx;
    const { processCollectorBundle } = await import("../lib/collector");
    await Promise.all(batch.messages.map(async (message) => {
      if ("kind" in message.body) {
        if (env.VOLUME_COLLECTION_ENABLED !== "true") { message.ack(); return; }
        try {
          const { collectVolume, publishRouteWindows } = await import("../lib/volume/collector");
          if (message.body.kind === "volume-collect") await collectVolume(message.body.protocol, env);
          else await publishRouteWindows(message.body.routeIds, message.body.cutoff, env);
          message.ack();
        } catch {
          console.error("Volume job failed", { kind: message.body.kind });
          message.retry({ delaySeconds: 60 });
        }
        return;
      }
      try {
        await processCollectorBundle(message.body, env);
        message.ack();
      } catch (error) {
        console.error("Collector bundle failed", {
          sweepId: message.body.sweepId,
          bundleIndex: message.body.bundleIndex,
          error: error instanceof Error ? error.message : "Unknown collector error",
        });
        message.retry({ delaySeconds: 60 });
      }
    }));
  },
};

export default worker;
