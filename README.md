# Stock Daily Briefing

Public, read-only market intelligence for S&P 500 and Nasdaq-100 investors.
The product publishes focused pre-market and post-close briefings with market
context, curated stock ideas, independent qualification, risks and provenance.

## PR #6 — frontend preview

This release validates the product experience before any new backend or private
runtime integration:

- short public landing page at `/`;
- local terminal preview and exact **View Live Dashboard** CTA;
- single public terminal at `/dashboard`, without tabs, sidebar or login;
- S&P 500, Nasdaq-100 and VIX context;
- curated-X discovery shown inline with stock analysis and provenance;
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
compatibility. They are not consumed by the new frontend preview. Later focused
PRs will add the validated DailyBriefing contract, private publisher and live
read model.

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
apps/web/worker                         Existing Cloudflare Worker and D1 read model
bot/bot                                 Existing private runtime foundation
packages/contracts                      Existing shared contracts; DailyBriefing v1 follows in PR #7
```

## Disclaimer

Stock Daily Briefing provides general market research for informational and
educational purposes only. Nothing on the website is a recommendation,
solicitation or personalised assessment to buy, hold or sell a security. Verify
all data and sources independently.
