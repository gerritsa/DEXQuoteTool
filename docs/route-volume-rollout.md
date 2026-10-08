# Route volume rollout

Volume insights lives at `/volume-insights?routeId=…`, separate from quote performance at `/routes/[routeId]`. The persistent navigation links Leaderboard, Route analysis, and Volume insights, including on mobile. `/routes` and `/volume-insights` offer source/destination selectors limited to the tracked directed route catalog and a switch for available reverse routes. Switching views preserves the pair and selected periods.

The volume page leads with observed USD input volume, successful swaps, and the actual covered interval. Its chart switches between USD volume and swap count in the same input-size buckets. Benchmark quote leaders appear in a separately labeled secondary row; provider coverage and sources are expandable below the chart. It retains independent 24-hour, 7-day and gated 30-day controls, volume/count tooltips, an accessible table, historical activity for providers whose support has changed, and horizontally scrollable mobile charts.

## Collection and retention

Collection runs through its own queue on `10,40 * * * *`, separate from half-hour quote collection. One provider lease prevents overlapping scans. Each task reads at most six pages (one for NEAR), checkpoints atomically, and yields. **Unfinished hours in the latest 24 hours always precede in-progress older jobs**, followed by recent rechecks and older work. Each provider's normal daily limit is **2,000 pages**, with **1,000 reserved for the latest 24 hours** and a separate **1,000-page background cap**. Background work cannot exhaust the live reserve or impose a provider-wide cooldown; it pauses its own hour while live work remains eligible. Counters reset at midnight UTC (8 p.m. Toronto during daylight saving time).

The migration conservatively classifies already-spent requests as background without resetting the total counter. For October 8, 2026 only, live work can use up to **250 additional pages per provider** to repair the freshness gap left by the old policy; this allowance expires automatically at the UTC date boundary. It cannot fund older backfill. A single hour is capped at 200 pages / 10,000 tracked parent swaps. Temporary swap storage is capped at **100,000 records per provider**, with **25,000 slots reserved for recent hours**. Budget/cap failures are visible through `/api/volume-health` and never become a false zero.

Provider APIs expose time-sliced history, so the implementation uses resumable **complete hourly scans** rather than assuming every API has a reliable forward status-update stream. It scans all tracked assets together, folds parents by ID, and publishes/replaces the hour after pagination completes. Recent hours get bounded rechecks after 3, 24 and 72 hours to catch late deposits/completions without fetching unfunded NEAR quote requests. Funded pending swaps get additional checks within the seven-day repair horizon. Already old backfill hours are scanned once. This also makes late-completion repairs idempotent after recent event records have expired. Provider-reported timestamps define period membership; these are not uniformly completion timestamps. NEAR/Chainflip use recorded creation/request time and Midgard uses its action timestamp. The page states this scope.

- Hourly volume and quote summaries: 35 days.
- Recent individual normalized records: 72 hours after collection for completed scans.
- Incomplete scan input: hard expiry after seven days, which invalidates its page cursor before deletion.
- R2 normalized hourly repair archives: seven days via `infra/r2-lifecycle.json`.
- Route/period payloads: replaced at the same 150 keys, with a five-minute public cache.

Background publisher messages handle five routes at a time, every half-hour. Quote leaders are rebuilt from the existing 32-day four-hour trend buckets, and refreshed after completed quote sweeps. No extension of detailed quote retention or seven separate public trend requests is needed. Displayed periods use the same complete-hour cutoff for volume and leaders. New histories show their actual collected-hour coverage until backfill completes.

## Paused 30-day volume view

`VOLUME_30D_ENABLED=false` disables the 30-day volume button and API period, restricts new ingestion/backfill to seven days, and publishes only the 24-hour and seven-day snapshots. Existing hourly volume and quote summaries still retain 35 days; they are preserved for later use. This switch affects volume, not the existing historical quote graph.

To re-enable later, set `VOLUME_30D_ENABLED=true` and deploy. The UI/API and collection horizon then return to 30 days. `/api/volume-health` exposes `thirtyDayReadiness` with shared completed hours out of 720. Fourteen days of additional collection may still leave a small gap; check coverage rather than promising a calendar date. Any remaining backfill is constrained to the background allowance and cannot displace recent-hour jobs.

## Verified feeds and remaining credential

THORChain and Maya bounded action queries were checked against their live Midgard endpoints, including full pagination. Action timestamps are nanoseconds, but query timestamp parameters are **seconds**. Both APIs cap filters at four assets. A three-asset endpoint cover reaches every fixed route: THORChain supports an OR query over that cover; Maya's older API requires separate single-asset shards because its multi-asset filter matches all specified assets. Continuation requests use the page token without a conflicting upper timestamp. Maya's legacy lower-timestamp path returns incorrect dates, so its adapter walks backwards from the upper bound and stops locally at the requested start. The staging ledger deduplicates parent swaps across shards. Internal trade/synth balances are excluded.

Displayed comparisons now use the latest contiguous block of hours completed by every provider participating in a route. Every provider's volume/count and the benchmark quote leaders use exactly the same start and end. Faster-provider history outside that shared block is retained but excluded from display. Unsupported providers do not block a route, while providers with actual historical trades or valid quotes in the selected period remain participants. The panel shows the shared start, end and hours available out of the selected 24/168/720-hour target. It waits instead of mixing unequal coverage. Versioned snapshots/cache keys prevent older unsynchronized payloads from being displayed during the rollout.

Chainflip's public explorer processor GraphQL query was validated against live hourly history. It selects `REGULAR` parent requests, sums executed non-gas `swapInputValueUsd`, excludes fully refunded requests with no executed chunks, and uses cursor pagination. Streaming/DCA child executions do not create additional swap counts.

NEAR's adapter uses the documented 1Click Explorer transaction feed with exact token/chain mapping, address-plus-memo identity, local [start,end) boundaries and at least 5.1 seconds between partner requests. Its **Explorer-specific partner JWT** has now been validated from the ignored local `.dev.vars` file. The existing quote API token is rejected by the Explorer API (`INVALID_TOKEN`, expected `key_type=explorer`), so production must receive the separate `NEAR_EXPLORER_API_KEY` secret. The adapter deliberately reports missing credentials as unavailable rather than inventing numbers.

Only external 1Click swaps are included in NEAR's current scope. The combined total is combined observed provider volume, which can overlap via underlying solver execution; it is not guaranteed unique global volume.

## Production activation

Production setup was completed on October 7, 2026: both volume queues were created, migrations 0009–0011 were applied, the validated Explorer key was installed as a Worker secret, and the seven-day `volume/` archive expiry rule was added while preserving quote retention. The Worker is deployed with `VOLUME_COLLECTION_ENABLED=true`, a 2,000-page daily budget per provider, and 100,000 temporary swap records per provider. Initial history collection begins on the scheduled `10,40 * * * *` trigger; the verified route-volume API reports its actual unavailable/partial coverage until those jobs finish.

The following commands document the setup for another environment or recovery; production resources already exist:

1. Create the volume jobs queue and its dead-letter queue:

   ```bash
   npx wrangler queues create dex-quote-tool-volume
   npx wrangler queues create dex-quote-tool-volume-dead-letter
   ```

2. Inspect pending database migrations, then apply the additive volume migrations `0009_material_true_believers.sql`, `0010_young_liz_osborn.sql`, and `0011_real_mantis.sql` through the existing migration command. There are no destructive volume migrations:

   ```bash
   npx wrangler d1 migrations list DB --remote --config wrangler.production.jsonc
   npm run db:migrate:production
   ```

3. Configure the Explorer JWT from the NEAR partner dashboard. Enter it through Wrangler's secret prompt, not in a committed file:

   ```bash
   npx wrangler secret put NEAR_EXPLORER_API_KEY --config wrangler.production.jsonc
   ```

4. Apply the archive lifecycle rules, including the new `volume/` expiry prefix. Set `VOLUME_COLLECTION_ENABLED` to `true` in the production variables, then build/deploy through the existing production command.
5. Monitor `/api/volume-health`, queue retries, D1 billed row writes/bytes, Worker CPU, and R2 operations. Check current account headroom before increasing page budgets. Coverage should improve as recent hours and then older history are collected; the initial 30-day backfill is deliberately budgeted rather than unbounded.

If an hour reaches six consecutive errors or its staged input expires, it is paused. After fixing the source/cap, an administrator can reset that specific hour; it must restart rather than reuse its old cursor:

```sql
UPDATE volume_feed_hours
SET status = 'pending', failures = 0, cursor = NULL, pages = 0,
    next_attempt = 0, last_error = NULL
WHERE id = :provider_and_hour;
```

The next collection attempt clears that hour's stage, advances its generation and performs a complete replacement scan. Retention only removes old detail; it never subtracts that detail from already published aggregates.

## Validation

Domain and in-memory D1 tests cover all bucket boundaries, e8/fixed-point amounts, streaming/DCA parent identities, full refunds, NEAR memo identity, missing vs zero coverage, quote ties, timestamp units, committed-page retry, late completions, request budgets, snapshot publication and retention. The repository build/rendered tests, lint and typecheck also pass.

Browser checks used clearly synthetic API fixtures against the local route page, verifying all three periods, bookmark state, hover tooltip values, dark/light rendering, and 320px mobile layout. These checks do not claim that a production volume backfill has run. Screenshots and the local browser-check script are in the ignored `work/` directory.
