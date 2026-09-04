# SwapRank

SwapRank compares synchronized cross-chain swap quotes from THORChain,
Maya Protocol, Chainflip, and NEAR Intents.

The benchmark covers 30 fixed directed routes, seven USD input sizes, and two
execution modes: Standard Swap and Streaming/DCA. Scheduled Cloudflare Workers
enqueue a complete sweep every 30 minutes. D1 stores queryable quote history
and R2 stores compressed archives.

Route analysis also includes a THORChain depth-and-price forecast. Each sweep
reuses its Midgard pool snapshot to calculate the pool-implied exchange rate
and simulate how the synchronized THORChain quote changes when route-pool
liquidity is scaled at constant pool prices. The forecast separates the
depth-recoverable quote gap from the remaining pool-rate gap, shows the depth
required to come within 5 bps of the best competing quote, and flags when
arbitrage-driven pool-price rebalancing is also needed.

## Local development

Requires Node.js 22.13 or newer.

```bash
npm install
npm run dev
```

Copy `.env.example` to `.env.local` and supply the required quote API key and
chain-specific benchmark addresses before running real quotes.

## Validation

```bash
npm run lint
npx tsc --noEmit
npm test
```

`npm test` builds the Worker and verifies the dashboard, public-route boundary,
and production collection bindings.

## Database

The Drizzle schema is in `db/schema.ts`. After changing it, regenerate the
migration with:

```bash
npm run db:generate
```

## Production

See [`PRODUCTION.md`](./PRODUCTION.md) for Cloudflare resource provisioning,
secrets, retention rules, and deployment steps.
