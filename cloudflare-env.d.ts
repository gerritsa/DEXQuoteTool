declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      ARCHIVE: R2Bucket;
      BENCHMARK_QUEUE: Queue;
      NEAR_INTENTS_API_KEY?: string;
      COLLECTOR_ADMIN_TOKEN?: string;
      BENCHMARK_BTC_ADDRESS?: string;
      BENCHMARK_EVM_ADDRESS?: string;
      BENCHMARK_TRON_ADDRESS?: string;
    }
  }
}

export {};
