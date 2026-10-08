declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      ARCHIVE: R2Bucket;
      BENCHMARK_QUEUE: Queue;
      VOLUME_QUEUE?: Queue;
      VOLUME_COLLECTION_ENABLED?: string;
      VOLUME_DAILY_PAGE_LIMIT?: string;
      VOLUME_LIVE_PAGE_RESERVE?: string;
      VOLUME_LIVE_CATCHUP_DAY?: string;
      VOLUME_LIVE_CATCHUP_PAGES?: string;
      VOLUME_30D_ENABLED?: string;
      NEAR_EXPLORER_API_KEY?: string;
      NEAR_INTENTS_API_KEY?: string;
      COLLECTOR_ADMIN_TOKEN?: string;
      BENCHMARK_BTC_ADDRESS?: string;
      BENCHMARK_EVM_ADDRESS?: string;
      BENCHMARK_TRON_ADDRESS?: string;
      BENCHMARK_SOL_ADDRESS?: string;
      BENCHMARK_LTC_ADDRESS?: string;
      BENCHMARK_BCH_ADDRESS?: string;
      BENCHMARK_XRP_ADDRESS?: string;
      BENCHMARK_DOGE_ADDRESS?: string;
    }
  }
}

export {};
