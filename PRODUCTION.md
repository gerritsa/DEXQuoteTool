# Production collector

The production collector is designed for 20 fixed routes, seven USD sizes, two
execution modes, and one sweep every 30 minutes.

## Runtime shape

- The half-hour Cron Trigger creates 280 route/size/mode jobs.
- Jobs are bundled in groups of 20, producing 14 queue messages per sweep.
- Queue messages are processed with four concurrent benchmark workers.
- D1 stores normalized quote data for 90 days and daily aggregates for 400 days.
- R2 stores one normalized and one raw gzip archive per queue bundle.
- The included R2 lifecycle rules expire `raw/` after seven days and
  `normalized/` after one year.

## Production resources

Before deployment, create one D1 database, one R2 bucket, the jobs queue, and
the dead-letter queue in the Cloudflare account. Replace the placeholder D1 ID
in `wrangler.production.jsonc`.

Run `npm run db:migrate:production` before deploying application code. Runtime
requests never create or alter production tables.

Configure these Worker secrets or variables:

- `NEAR_INTENTS_API_KEY`
- `BENCHMARK_BTC_ADDRESS`
- `BENCHMARK_EVM_ADDRESS`
- `BENCHMARK_TRON_ADDRESS`
- `COLLECTOR_ADMIN_TOKEN` only when administrator-triggered single runs are needed

`POST /api/runs` is hidden unless a matching administrator bearer token is
configured; normal dashboard reads remain public.

## Retention and budget controls

The daily maintenance trigger runs at 00:15 UTC. It builds the previous day's
metrics for every enabled-protocol combination, removes detailed D1 history
older than 90 days, removes collector bookkeeping older than 90 days, and keeps
daily metrics for 400 days.

## Monitoring

Monitor `GET /api/health` at least every five minutes. It returns a non-200
status when no sweep has completed within 75 minutes, a sweep is stuck for more
than 45 minutes, fixed routes are missing, or a partner's two-hour quote error
rate exceeds 20 percent. Configure alerts for the dead-letter queue, Worker
exceptions, D1 usage, R2 usage, and Queue operations in the Cloudflare account.

Apply `infra/r2-lifecycle.json` to the production archive bucket. It expires
`raw/` after 7 days and `normalized/` after 365 days. Monitor D1 stored bytes,
rows written, Queue operations, Worker requests, and R2 Class A operations in
the Cloudflare dashboard before enabling public traffic.
