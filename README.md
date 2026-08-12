# Morning Briefing

Public, read-only market intelligence for S&P 500 and Nasdaq-100 investors.
The product publishes focused pre-market and post-close briefings with market
context, curated stock ideas, independent qualification, risks and provenance.

## Current frontend

The approved **Morning Briefing** interface is the public, read-only product shell:

- Morning Briefing uses the published briefing, market/status and candidate APIs;
- X Surge uses the curated X posts API;
- Earnings uses the existing earnings schedule API;
- fields without a backend source remain visibly labelled Demo;
- no login, personal portfolio, watchlist, chat or trading actions.

The legacy information pages remain available while the new product shell runs at
`/`, `/dashboard`, `/x` and `/earnings`.

## Previous PR #6 frontend

This release validates the product experience before any new backend or private
runtime integration:

- short public landing page at `/`;
- local terminal preview and exact **View Live Dashboard** CTA;
- single public terminal at `/dashboard` with a fixed desktop menu and mobile hamburger;
- three dashboard views: **Morning briefing**, **X search** and **Earnings**;
- Today’s Morning briefing information is available as frontend-only `Example Data`;
- planned X search and Earnings views are non-clickable **Coming soon** entries;
- informational verdicts: **Potential Entry**, **Watch**, **Avoid** and
  **Insufficient Data**;
- public Methodology, Status and Disclaimer pages;
- safe redirects from legacy product routes to `/dashboard`;
- responsive mobile and desktop layouts.

All values shown in PR #6 come from the frontend-only
`apps/web/src/daily-briefing-example.ts` fixture and are labelled
**Example Data**. They are synthetic and are not live quotes, current X posts or
claims about market conditions.

## Deliberately not included in PR #6

- live X Search or TradingView MCP calls;
- a new public API, D1 schema or migration;
- briefing ingestion or publishing;
- cron or market-session scheduling;
- authentication;
- broker, order, paper-trading or live-trading functionality.

The existing Worker/D1 and private Python foundations remain unchanged for
compatibility. PR #7 now adds the shared, runtime-validated `DailyBriefing` v1
contract plus its append-only D1/API read model:

- signed `DAILY_BRIEFING_PUBLISHED` ingestion through the existing HMAC endpoint;
- content hashing, idempotent replay handling and same-edition conflict rejection;
- `GET /api/briefs/latest` and `GET /api/briefs/:date/:editionType`;
- `/api/status` freshness metadata with honest no-brief responses;
- local D1 migration and unit/integration coverage.

PR #7 still does not add external X/TradingView collection, a publisher, a
scheduler or a frontend live-data adapter. Those remain separate PR8/PR9 work.
The public preview continues to render the synthetic `Example Data` fixture until
that adapter is deliberately introduced.

## Briefing rhythm

The planned canonical timezone is `America/New_York`:

- pre-market: `08:30 ET` on valid market sessions;
- post-close: `16:30 ET` on valid market sessions.

PR #6 displays this schedule only. It does not create a scheduler.

## Development

Prerequisites: Node 20+ (Node 22 recommended) and npm.

```bash
npm ci
npm run dev
```

The Vite app opens at `http://localhost:5173`.

## Quality gates

```bash
npm run lint
npm run typecheck
npm test
npm run build
npx wrangler deploy --dry-run
```

The repository also retains Python runtime tests under `bot/tests` to protect
existing foundations from frontend regressions.

## Project structure

```text
apps/web/src/daily-briefing-pages.tsx   Public landing, terminal and information pages
apps/web/src/daily-briefing-example.ts  Single synthetic PR #6 fixture
apps/web/src/daily-briefing.css         Isolated responsive product styling
apps/web/worker                         Worker routes, signed ingest and DailyBriefing read model
apps/web/worker/daily-briefings.ts      Idempotent D1 publication/read helpers
apps/web/migrations/0004_daily_briefings.sql  Append-only DailyBriefing D1 table
bot/bot                                 Existing private runtime foundation
packages/contracts/src/daily-briefing.ts  Shared validated DailyBriefing v1 contract
packages/contracts                      Existing shared contracts and schemas
```

## Disclaimer

Stock Daily Briefing provides general market research for informational and
educational purposes only. Nothing on the website is a recommendation,
solicitation or personalised assessment to buy, hold or sell a security. Verify
all data and sources independently.
