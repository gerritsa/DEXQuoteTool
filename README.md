# SwapRank

SwapRank compares synchronized cross-chain swap quotes from THORChain,
Maya Protocol, Chainflip, and NEAR Intents.

The benchmark covers 50 fixed directed routes and seven USD input sizes. Each
protocol is queried once for its best-output strategy: automatic streaming for
THORChain and Maya, the better of Chainflip's regular and DCA candidates, and
the NEAR solver quote. Scheduled Cloudflare Workers enqueue a complete sweep
every 30 minutes. D1 stores queryable quote history and R2 stores compressed
archives.

The route-first `/analytics` dashboard keeps route coverage and quote
availability at the DEX portfolio level, then compares price execution
like-for-like on one selected route across all seven trade sizes. Best-quote
rate answers whether a DEX actually served the customer; pairwise beat rate
also credits second- and third-place quotes for the competing quotes they beat.
Unsupported pairs appear as `N/A` and do not count as losses or availability
failures. A sole valid quote still wins its comparison but is excluded from
pairwise scoring because no competing quote was available.

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
