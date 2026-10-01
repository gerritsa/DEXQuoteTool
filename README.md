# SwapRank

SwapRank compares synchronized cross-chain swap quotes from THORChain,
Maya Protocol, Chainflip, and NEAR Intents.

The benchmark covers 30 fixed directed routes and seven USD input sizes. Each
protocol is queried once for its best-output strategy: automatic streaming for
THORChain and Maya, the better of Chainflip's regular and DCA candidates, and
the NEAR solver quote. Scheduled Cloudflare Workers enqueue a complete sweep
every 30 minutes. D1 stores queryable quote history and R2 stores compressed
archives.

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
