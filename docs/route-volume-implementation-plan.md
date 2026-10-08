# Route volume by trade size: implementation plan

Status: proposed design, October 7, 2026. This document plans the feature; it does not enable collection or change production.

## Outcome and placement

Add a **Trading volume by size** section to the existing `/routes/[routeId]` route analysis page. It shows observed USD input volume and successful customer swap counts for THORChain, Maya, Chainflip, and NEAR Intents, with **24 hours / 7 days / 30 days** choices.

Recommended page order:

1. Route heading and telemetry.
2. Latest quote comparison.
3. **Trading volume by size**: period selector, route volume and swap totals, coverage/freshness, stacked chart, and aligned quote-leader row.
4. Existing exact-size picker and historical price chart.

Use the active route page and `app/swap-rank-dashboard.tsx`, which renders `view="analysis"`. The old `/analytics` page currently returns `notFound()`; do not revive it for this feature. Keep the new volume section out of the leaderboard. Its data model can support volume-weighted rankings later, but changing rankings is a separate feature.

The new section compares all four providers, independent of the inherited leaderboard protocol filters. Display that scope in its legend. The historical quote chart may keep its existing filters and 14-day option. Give the new section its own `volumeDays=1|7|30` URL state so the existing controls are not silently repurposed.

## Measurement contract

Use exact directed routes, preserving chain, native/token identity, and contract address. BTC → ETH differs from ETH → BTC; Ethereum USDC differs from USDC on another chain. Maintain a versioned mapping from each source's asset identifiers to our fixed route identifiers. Historical collection must not depend on the current live catalog having at least two supported providers; a route losing current quote support should not lose its historical volume.

Count one successful customer swap once. Exclude quotes, liquidity operations, refunds, failed swaps, internal intermediary pool legs, fee transfers, and solver rebalancing where the feed distinguishes it. Fold streaming/DCA children into their parent customer swap. Partially refunded or partially filled swaps require an explicit adapter rule: include only economically settled input, or report them separately if the source cannot provide that amount reliably. Never sum the original requested deposit as if it all executed.

Volume is the USD value of executed input, using the source's documented historical USD amount or price at execution. Do not add both input and output value, and do not value historical swaps at today's price. Use decimal arithmetic and fixed-point storage, with documented rounding, before comparing bucket boundaries. Unknown USD valuation is an unclassified swap count, not a zero-dollar swap or a guessed size bucket.

Before writing collectors, verify the available timestamp semantics in all four feeds. Preferred period membership is terminal economic execution time. NEAR's documented transaction schema exposes `createdAt` but does not establish a completion timestamp. If completion time cannot be obtained affordably for all four, use an explicitly documented initiation-based series for all providers: successful swaps attributed to their original swap time, with late completion updates to that historical bucket. Label that series accordingly. Do not quietly mix completion-based and creation-based windows. Resolve this in the source-validation phase, including long-running swaps.

Use these mutually exclusive USD input buckets:

| Display | Membership | Benchmark used for quote leader |
| --- | --- | --- |
| ≤$500 | 0 < input ≤ 500 | $500 |
| $500–$1K | 500 < input ≤ 1,000 | $1K |
| $1K–$10K | 1,000 < input ≤ 10,000 | $10K |
| $10K–$50K | 10,000 < input ≤ 50,000 | $50K |
| $50K–$100K | 50,000 < input ≤ 100,000 | $100K |
| $100K–$500K | 100,000 < input ≤ 500,000 | $500K |
| $500K–$1M | 500,000 < input ≤ 1,000,000 | $1M |
| >$1M | input > 1,000,000 | No benchmark |

The quote-leader row means **most frequent best quote at the representative benchmark size**, not the provider that executed the most volume or demonstrably won all actual swaps in a bucket. Preserve fractional credit for quote ties, show tied leaders, and show sample count and competition coverage. Keep the current treatment of a sole successful quote explicit. Do not invent a quote winner for >$1M.

The combined route total is the sum of observed provider volumes. Call it **Combined observed volume**, with source scope attached. It is not automatically a count of unique global trades: aggregators/solvers can route underlying execution through other protocols. Validate overlap in the source study; if cross-provider deduplication is unavailable, disclose the sum's scope and do not claim unique market volume.

## Validate the four feeds first

Create an adapter contract and collect small timestamped fixtures before implementing full ingestion. Each source must provide reproducible pagination, customer swap identity, exact assets, executed amount, success/partial/refund semantics, timestamp semantics, historical USD valuation, late updates, and an affordable history traversal strategy. Record coverage and published rate limits.

| Provider | Starting source | Required validation |
| --- | --- | --- |
| THORChain | Midgard `/v2/actions` | Route filtering locally; 50-action pagination; action vs streaming-child identity; timestamps; USD fields; finality and late status changes. `/v2/history/swaps` pool totals do not identify exact routes. |
| Maya | Maya Midgard `/v2/actions` | Same tests, using Maya's schema and USD/amount units rather than assuming THORChain equivalence. |
| Chainflip | Supported explorer/indexer history source | Identify and prove access to an incremental completed-swap feed, parent DCA request identity, finality, amounts, historical prices, pagination, retention, and stable API contract. Public analytics alone do not establish that contract. |
| NEAR Intents | Documented Explorer `/api/v0/transactions` | Partner JWT, cursor pagination, up to 1,000 records/page, one request per five seconds per partner, status updates, `amountInUsd`, transaction identity and time. Documentation describes 1Click history, so do not label it all NEAR protocol volume. |

Request only fields needed for these metrics where the source supports it. Fetch one provider-wide feed, or a small fixed set of disjoint asset shards if supported filters reduce traffic. Do not make 50 independent route scans or seven scans per trade-size bucket. Filter tracked routes locally. Do not use API USD range filters as our bucket definition without proving their semantics; NEAR documents filters affecting both input and output amounts.

A provider is enabled only after the adapter passes these checks. UI may display explicitly partial coverage during staged rollout, but a complete four-provider total must wait for all four validated feeds. If an API is restricted to our own integration's transactions, that is insufficient for market-wide volume.

## Collection and resource controls

Reuse Cloudflare Workers, D1 and R2, with a **separate volume queue and dead-letter queue**. This isolates slower history ingestion and API rate limits from the existing quote queue. Update `worker/index.ts` to dispatch by queue and cron identity; it currently sends every non-maintenance cron to quote collection.

Schedule a small dispatcher every 30 minutes. It starts or resumes one task per provider/shard, guarded by a database lease and durable checkpoint. Queue messages carry provider, bounded time slice, cursor and schema version, not entire event payloads. Start with total volume-queue concurrency two, at most one active task per provider, and provider-specific request pacing. NEAR pacing must be shared across every job using the partner token, including backfills.

Initial per-invocation budget: at most 20 source-page requests and 20 seconds of work, with continuation before the existing 30-second Worker CPU and 200-subrequest configuration are reached. Add byte/record limits before deserialization and chunk D1 batches to its limits. Treat these as starting limits to tune from measured feeds, not a promise of exact runtime or cost. Retries use exponential backoff, jitter and Retry-After; authentication failures disable that source's jobs until corrected. Budget exhaustion checkpoints and yields without dropping data.

Fetch forward from the last durable ingestion cursor, not from the start of the selected 30-day window. A timestamp-only checkpoint is insufficient when multiple records share a timestamp; use the source's stable cursor/event ID. Time boundaries must be locally normalized to [start,end), allowing safe overlap for feeds with exclusive endpoints.

Handle feeds ordered by creation time by tracking outstanding swaps and reconciling recent windows; a new-only feed filtered to SUCCESS can miss old swaps that finish later. Initial repair window: 72 hours, with bounded reconciliation of older unresolved IDs up to seven days, and explicit gap status thereafter. Prefer a source status-update cursor where available. Validate a provider-specific reconciliation strategy and its request budget before enabling it; do not blindly re-fetch three full days every 30 minutes.

Use a short-lived normalized event ledger for tracked routes only, keyed by `(provider, customer_swap_id)`. Store only route key, event time, version/hash, executed USD amount, bucket and terminal status. Insert/update idempotently and rebuild an affected hourly total from this ledger only when it still contains that hour's complete normalized input. Expire finalized ledger hours as whole units, after their totals are committed. An old pending swap finishing after its hour's ledger has expired must trigger a complete hour rebuild, not replace the existing aggregate with just that newly finished event. Avoid incrementing totals on every retry. Persist events and the accepted page/checkpoint in an atomic D1 batch, with fencing for stale leases. Do not advance a cursor until data is committed. A failure between commit and message acknowledgement must produce the same final totals on retry.

After the recent ledger expires, repairs must rebuild a complete hour from source history or retained normalized R2 data and atomically **replace** that hour's aggregate. Never replay old rows as additive deltas after their deduplication keys have expired. Stable initiation-time attribution simplifies that boundary; completion-time attribution requires durable tracking of long-running parents until final status.

## Bounded database design

Use compact internal route and provider keys instead of repeating long asset addresses in each aggregate row. Store all eight size buckets together per hour, rather than multiplying rows by size and selected period. Suggested tables:

| Table | Key / purpose | Retention |
| --- | --- | --- |
| `volume_routes` | Route key, asset identities, mapping version | Fixed tracked route set |
| `volume_hourly` | Route + provider + hour; eight volume/count buckets, unknown-valuation count, revision | 35 days |
| `volume_feed_hours` | Provider/shard + hour; complete/partial/gap, covered interval, source scope | 35 days |
| `volume_ingestion_state` | Provider/shard checkpoint, lease, error/backoff | Fixed source/shard set |
| `volume_recent_swaps` | Provider + customer swap ID; minimal normalization/deduplication record | Complete event-time hours for 72 hours; pending identity exception capped at seven days |
| `route_quote_hourly` | Route + hour; seven sizes × four providers, win credits and sample/availability counts | 35 days |
| `route_volume_windows` | Route + period; published chart payload including quote leaders and coverage | At most 150 rows for 50 routes |

For 50 routes and four providers, the dense upper bound for the main volume aggregate is **50 × 4 × 24 × 35 = 168,000 rows**. Quote hourly summaries add **42,000 rows**; an unsharded feed-coverage ledger adds **3,360 rows**. One-hour snapshots at the same key are replaced, not appended. Sparse storage can reduce this further, but a missing row only means zero when feed coverage proves that interval was fully scanned.

Recent-event storage scales with roughly three days of tracked swap throughput, plus the seven-day pending exception; it is not an indefinite transaction table. Measure this volume and bytes before rollout. Add configurable row/byte high-water marks and monitor real SQLite/index size. If reaching a cap, stop the affected ingestion task, retain its checkpoint, mark coverage partial and alert; never silently discard events. Move temporary normalized data to R2 if measured throughput makes the recent ledger unsuitable for D1.

Daily maintenance deletes expired rows in bounded indexed batches and removes expired checkpoints/jobs. Add only necessary indexes: aggregate `(route_key, hour, provider)`, expiry by hour, event identity, and event time/affected hour for repair. Confirm query plans. Avoid daily, weekly, monthly, per-mask, and per-bucket copies of the volume data. 24h, 7d and 30d snapshots are small replaceable caches of the same hourly truth.

R2 stores compressed normalized batches under **new** `volume/` prefixes with explicit lifecycle expiry after seven days. Optional raw debugging payloads expire after 48 hours. Coalesce pages into bounded chunks rather than creating an object per swap. Do not inherit the existing 2,000-day quote archive retention. Avoid storing wallet addresses and other unused transaction fields. Backfill temporary objects also have expiry rules.

This feature's retained footprint reaches a steady state. Actual bytes and bill cannot be guaranteed from row counts alone; existing quote data also consumes the database budget. Sample production-shaped rows and measure bytes, indexes, rows written, R2 operations and queue usage during the source study.

## Windows, publication and quote leaders

Use trailing **24 / 168 / 720 complete UTC hours**, ending at the latest validated common publication boundary. Display **Data through [timestamp]** in the user's local time. This deliberately has hourly freshness rather than minute-exact membership; do not imply live totals through the current minute. All providers and quote-leader results use the same [start,end) window.

Do not let one unavailable source freeze the chart forever. Publish partial windows with explicit per-provider coverage, missing hours and per-source freshness, instead of calling their subtotal a complete combined total. A successful feed with no swaps shows zero; a failed scan shows unavailable; a startup window lacking history shows partial. Stale data retains its actual cutoff and a stale indicator.

Add compact quote win summaries after existing quote collection completes, for all seven benchmark sizes at once. Reuse the current best-output scoring and eligibility snapshots rather than reevaluating historical route support from today's catalog. Compute all-four-provider leaders from summed win credits/sample counts across the same hourly window; do not average percentages, select the largest volume provider, or fetch `/api/trends` seven times. These summaries are for the new panel's fixed four-provider comparison; do not materialize every protocol subset.

Historical quote summaries can be rebuilt from existing detailed rows for the recent eight days and from normalized R2 quote archives for older days, where archive schema/availability permits. Validate that reconstruction before promising 30 days of leaders. Missing historical leaders must remain missing even if swap volume has been backfilled successfully.

After new/changed hourly totals, mark affected routes dirty and coalesce refreshes into one publisher per route/cutoff. It reads at most 720 hours × four provider rows per route and one hourly quote summary per hour, builds all three windows, and atomically replaces their snapshots. Publish coverage and revision with the payload. A correction changes any window containing its hour. Rebuilding only dirty route windows plus a bounded once-hourly cutoff refresh keeps read work predictable.

Expose `GET /api/route-volume?routeId=...&days=1|7|30`. Validate route and period. Return only the selected route's published payload: eight buckets, four provider totals/counts, combined observed totals, seven benchmark leaders, coverage, source scope, start/end, freshness and revision. Provider calls and raw swap scans never run in public requests. Use the existing canonical HTTP cache helpers, adding this endpoint with a five-minute shared-cache TTL and ETag/revision support. Fetch only on route/period changes; hover is entirely local.

## Chart behavior

Render an ordinary linear stacked bar chart: size buckets along x, actual USD volume along y, four stable provider colors, combined total above each bar. Show >$1M separately with no benchmark leader. Below each benchmark bucket, align provider name/mark, win rate and sample count; support ties and no-data states. Include a concise label that this is sampled best-quote leadership at the benchmark amount.

Hover, keyboard focus or touch selection on a colored segment reveals provider, exact route, bucket range, selected period, USD executed volume, successful customer swap count, and coverage if incomplete. Use an accessible data table on small screens or as an equivalent view, so narrow bars and zero-volume providers remain inspectable. Volume legend entries should not secretly alter the combined total or quote-winning competitor set.

Use an independent loading/error boundary so volume failure does not hide latest quotes or the existing history chart. Show unclassified swap counts where USD valuation or route mapping is missing; do not imply complete size distribution when excluded records exist. No volume-weighted leaderboard change is included in this rollout.

## Delivery order and acceptance

1. **Source feasibility and cost sample.** Validate all four adapters and timestamp/coverage semantics, collect sample fixtures, measure pages/events/bytes per hour, identify credentials and rate budgets. Chainflip history and market-wide NEAR scope are explicit gates, not established capabilities.
2. **Storage and ingestion foundation.** Add migrations, compact keys, bounded ledger, queues, leases, checkpoints, retries, R2 lifecycle and retention. Implement a deterministic normalizer and hour replacement path. Start with THORChain/Maya, then add validated Chainflip/NEAR adapters behind feature flags.
3. **Aggregation and publication.** Add hourly quote summaries, coverage ledger, three rolling windows and cached route-volume endpoint. Test repair/publication behavior before displaying combined totals.
4. **Route analysis UI.** Add the volume section, period URL state, chart/tooltips, aligned leaders, accessible table, and partial/zero/stale states. Verify light/dark appearance, desktop, 320px mobile, keyboard and touch behavior.
5. **Controlled backfill and rollout.** Prioritize fresh ingestion. Backfill 24 hours, then seven days, then 30 days using checkpointed low-priority jobs and a separate daily request budget. Display actual coverage throughout. A period becomes complete only after every required hour/source passes validation. Reconcile totals with providers for identical route, scope, valuation and timestamp rules; do not compare exact route sums to network-wide pool totals.

Required correctness tests cover exact bucket boundaries, fixed-point rounding, asset/chain normalization, direction, streaming/DCA parents, partial refunds, late SUCCESS updates, duplicate/reordered pages, crash after commit before ack, concurrent lease expiry, zero vs missing, retention-boundary repair, gaps/backfill, tie credit, and identical volume/quote windows. Load-test one cache miss, maximum-size queue page and 30-day window rebuild. Run the repository's lint, typecheck and build/test checks after implementation.

Initial operational acceptance: background-only source calls; visible data cutoff normally within two hours after feeds permit finalization; no duplicate counts under forced retries; public responses read at most a snapshot plus bounded metadata; aggregate row counts stop growing after 35-day retention plus maintenance delay; event/queue/R2 caps are observable; quote collection remains unaffected by a volume provider outage.

Suggested alerts: source lag over two hours, growing checkpoint backlog, repeated 401/429/5xx, dead-letter jobs, coverage gaps, unknown valuation rates, retention failures, and row/byte high-water marks. Choose the final request and storage ceilings from measured API payloads and the account's existing headroom, before enabling all providers.

## Retention clarification and $5 plan cost assessment

Checked Cloudflare's published prices on October 7, 2026. This is a design estimate, not a read of the account's actual usage or invoice.

Aggregation starts during collection; it does not wait for a swap to become 24 hours old. Completed swaps contribute to hourly totals, and chart windows sum those totals. The 72-hour recent-swap ledger is only for safe deduplication, late updates and correction. After that, finalized individual records are deleted from D1 while the hourly totals remain for 35 days. Seven-day normalized R2 batches are temporary repair material and then expire too. Reducing the D1 ledger to 24 hours is possible after measuring late-update behavior, but the 72-hour buffer is the starting reliability choice, not a requirement of the 30-day chart.

Current published monthly allowances and overages:

| Service | Included allowance relevant here | Published overage |
| --- | --- | --- |
| Workers Standard, $5 minimum | 10 million requests; 30 million CPU milliseconds | $0.30/million requests; $0.02/million CPU milliseconds |
| D1 on Workers Paid | 25 billion rows read; 50 million rows written; 5 GB storage | $0.001/million rows read; $1/million rows written; $0.75/GB-month |
| Queues on Workers Paid | 1 million operations | $0.40/million operations |
| R2 Standard | 10 GB-month; 1 million Class A; 10 million Class B operations | $0.015/GB-month; $4.50/million Class A; $0.36/million Class B, subject to billing-unit rounding |

Allowances are shared with other usage in the account, not fresh allowances for the new collector. Outbound provider API calls are not separately billed as Worker requests. Waiting for APIs is not billed as CPU execution; parsing, normalization, compression and publication are. Keep job-level summary logs rather than logging every swap.

Illustrative steady-state model for a 30-day billing month, excluding continuation jobs, retries, backfills, public traffic and provider-specific repair requests:

- Four provider tasks every 30 minutes: **5,760 tasks/month**.
- One publisher task per route per hour: **36,000 tasks/month**.
- If all these use sub-64-KB queue messages, normal delivery consumes **125,280 queue operations/month**. Existing quote collection's configured 18 bundles per half-hour adds approximately **77,760 operations/month** before retries; the combined baseline is still below one million.
- Assuming, solely for illustration, one CPU second per provider task and 100 CPU milliseconds per publisher, the added CPU is **9.36 million milliseconds/month**. If it fits remaining allowance, CPU overage is zero; if the allowance is already fully used, that CPU quantity costs approximately **$0.19**. Measure actual CPU rather than treating these example timings as a forecast.
- Dense hourly volume insertions and eventual deletions are **288,000 base row writes/month**; quote-summary insertions/deletions add **72,000**, and three route-window updates per hour add **108,000**. These exclude indexes, checkpoints, corrections and individual swap-ledger writes.
- A 30-day full-window publisher scan at that cadence is approximately **129.6 million base rows read/month**, before extra scans and repairs, versus the 25-billion included allowance. Confirm actual `rows_read` with indexed queries.

The largest variable is recent-swap ledger **writes**, not aggregate storage. At 100,000 tracked swaps/day, one insert plus one eventual delete means six million base row writes/month, before indexes and status changes. Keep only tracked routes, minimize indexes, avoid writing unchanged records, and rebuild each touched hour once per committed batch rather than once per event. Once the shared write allowance is exhausted, every further million billed row writes costs $1.

The feature should be capable of fitting the existing $5 plan with sufficient account headroom; a firm zero-increase promise needs current Worker CPU/request totals, D1 rows written/storage, Queues operations and R2 totals. Initial 30-day backfill is a separate one-time workload with a request and write budget. Provider API charges, if required, are separate from Cloudflare. Sample ingestion and record D1 `meta.rows_read` / `meta.rows_written` and actual CPU before selecting final production limits.

## Verified source references

- [THORChain Midgard OpenAPI](https://gitlab.com/thorchain/midgard/-/blob/develop/openapi/openapi.yaml): action pagination, pool-vs-action history, USD fields and swap metadata.
- [Maya Midgard API](https://midgard.mayachain.info/v2/doc): separate Maya schema and swap/action data.
- [NEAR Explorer API introduction](https://docs.near-intents.org/integration/distribution-channels/1click-api/explorer/introduction): 1Click scope, partner JWT and one request per five seconds.
- [NEAR transaction API](https://docs.near-intents.org/api-reference/get-transactions): pagination size/cursors, assets, statuses, creation timestamp, USD amounts and filters.
- [Chainflip analytics announcement](https://chainflip.io/blog/upgraded-swap-stats): public swap analytics exist; this does not prove a supported history-ingestion endpoint.
- [Cloudflare D1 limits](https://developers.cloudflare.com/d1/platform/limits/): current database and query limits; account plan and existing usage must be checked before rollout.
- [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/): $5 minimum, request/CPU allowances and outbound-subrequest billing.
- [Cloudflare D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/): included usage, index write accounting, deletion writes and storage pricing.
- [Cloudflare Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/): included operations and normal three-operation message delivery.
- [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/): Standard storage allowances, operations and billing-unit rounding.
