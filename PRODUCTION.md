# Production collector

Route-volume collection and its separate activation steps are documented in
[`docs/route-volume-rollout.md`](./docs/route-volume-rollout.md). Production
collection is enabled with the volume queue bindings, additive migrations,
Explorer credential and fixed request/storage budgets provisioned.

The production collector is designed for 50 fixed routes, seven USD sizes, one
best-output quote strategy, and one sweep every 30 minutes.

## Runtime shape

- The half-hour Cron Trigger creates 350 route/size jobs.
- Jobs are bundled in groups of 20, producing 18 queue messages per sweep.
- Queue messages are processed with four concurrent benchmark workers.
- D1 stores detailed quote data for eight days and compact daily aggregates for
  2,000 days.
- R2 stores one normalized and one raw gzip archive per queue bundle.
- The included R2 lifecycle rules expire `raw/` after seven days and
  `normalized/` after 2,000 days.

## Production resources

Before deployment, create one D1 database, one R2 bucket, the jobs queue, and
the dead-letter queue in the Cloudflare account. Replace the placeholder D1 ID
in `wrangler.production.jsonc`.

Run `npm run db:migrate:production` before deploying application code. Runtime
requests never create or alter production tables.

Migration `0003_windy_enchantress.sql` introduces THORChain oracle-relative
benchmarking and intentionally clears the active benchmark, comparison, trend,
and collector tables for a fresh oracle-referenced history. The persisted route
catalog and lifecycle-managed R2 archives are not removed.

Migration `0007_flippant_ben_parker.sql` converts daily metrics from one row per
protocol/filter combination to one compact row per route, size, and day. It keeps
all existing optimized-mode filter combinations and clears retired pool-depth
snapshots. Daily maintenance removes legacy standard-mode and expired detailed
rows in bounded batches so the migration itself does not issue a very large
delete.

Configure these Worker secrets or variables:

- `NEAR_INTENTS_API_KEY`
- `BENCHMARK_BTC_ADDRESS`
- `BENCHMARK_EVM_ADDRESS`
- `BENCHMARK_TRON_ADDRESS`
- `BENCHMARK_SOL_ADDRESS`
- `BENCHMARK_LTC_ADDRESS`
- `BENCHMARK_BCH_ADDRESS`
- `BENCHMARK_XRP_ADDRESS`
- `BENCHMARK_DOGE_ADDRESS`
- `BENCHMARK_ZEC_ADDRESS`
- `COLLECTOR_ADMIN_TOKEN` only when administrator-triggered single runs are needed

The public Zcash benchmark address is stored as `BENCHMARK_ZEC_ADDRESS` in
`wrangler.production.jsonc`; the remaining values continue to be managed as
Worker secrets.

`POST /api/runs` is hidden unless a matching administrator bearer token is
configured; normal dashboard reads remain public.

## Retention and budget controls

The daily maintenance trigger runs at 00:15 UTC. It builds the previous day's
metrics for every enabled-protocol combination, removes detailed D1 history
and collector bookkeeping older than eight days, and keeps compact daily metrics
for 2,000 days. Thirty-day charts remain available from precomputed trend buckets,
while normalized R2 archives retain the inputs needed for future analysis for the
same 2,000-day period.

Route charts merge completed quotes newer than their precomputed history without
waiting for the whole collector sweep. The recent read uses the existing route/size
and quote indexes, is capped at 24 hours and 64 batches, and deduplicates batch IDs.
The chart uses the comparison card's completed batch ID as its cache revision;
the fifteen-minute shared cache and existing page refresh schedule remain in place.
The page shows the actual latest plotted check, and point tooltips include timestamps.
This adds no provider requests, database tables, or retention.

Latest leaderboard responses use a revision derived from the completed quote
entries, read through the fixed-size `idx_latest_quote_payloads_revision` covering
index. Quote cards also cache by completed batch ID. Opening a leaderboard cell
passes its batch ID to analysis, so its card and chart agree even if another
comparison finishes during navigation. "Use latest check", automatic refresh,
and changing trade size release that selection and load the latest completed batch.

## Monitoring

Monitor `GET /api/health` at least every five minutes. It returns a non-200
status when no sweep has completed within 75 minutes, a sweep is stuck for more
than 45 minutes, fixed routes are missing, or a partner's two-hour quote error
rate exceeds 20 percent. Configure alerts for the dead-letter queue, Worker
exceptions, D1 usage, R2 usage, and Queue operations in the Cloudflare account.

Apply `infra/r2-lifecycle.json` to the production archive bucket. It expires
`raw/` after 7 days and `normalized/` after 2,000 days. Monitor D1 stored bytes,
rows written, Queue operations, Worker requests, and R2 Class A operations in
the Cloudflare dashboard before enabling public traffic.
