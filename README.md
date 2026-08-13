# Morning Briefing

Public, read-only market intelligence for S&P 500 and Nasdaq-100 investors.

## Current frontend

The approved **Morning Briefing** interface is the public product shell:

- Morning Briefing consumes the published briefing, market/status and candidate APIs;
- X Pulse consumes curated posts from the tracked X accounts;
- Earnings consumes the D1 earnings schedule;
- missing backend fields use conservative fallback data internally;
- stale or invalid backend values are never presented as live;
- the frontend refreshes silently while the backend controls publication cadence;
- there is no login, portfolio, watchlist, chat or trading action.

Routes: `/`, `/dashboard`, `/x` and `/earnings`. The public Methodology, Status
and Disclaimer routes remain available.

## Historical frontend work

PR #6 introduced the first synthetic, frontend-only product demo. PR #7 added
the validated `DailyBriefing` contract and D1 read model. PR #8 added curated X
post ingestion. PR #9 replaces that demo shell with the current live-aware
Morning Briefing frontend while retaining conservative mock fallbacks for fields
whose APIs do not yet exist. Source-refresh mechanics are kept out of the main
product UI; values can still be delayed or illustrative when no backend field is
available.

## Briefing rhythm

Canonical timezone: `America/New_York`.

- pre-market: `08:30 ET` on valid market sessions;
- post-close: `16:30 ET` on valid market sessions.

## Cloudflare market context

Market indices and Fear & Greed are collected by the Worker Cron Triggers and
stored in D1. The public API composes those rows with the screening read model;
the VPS publisher does not write market-context data.

The Worker schedules are UTC because Cloudflare Cron Triggers are UTC: indices
run every 15 minutes on weekdays and are accepted only inside the New York
regular session (including the supported 13:00 ET early-close calendar) plus
one post-close run; Fear & Greed runs at 14:00 and 19:00 UTC on weekdays. The
Worker applies `America/New_York` conversion, weekends, holidays, DST and
source-date validation before writing.

The index adapter currently uses Financial Modeling Prep's documented HTTP
quote endpoint for `^GSPC`, `^NDX`, `^DJI` and `^VIX`. Configure its key only as
a Cloudflare secret:

```bash
cd apps/web
npx --yes wrangler@4 secret put FMP_API_KEY
```

The adapter is isolated behind `MarketDataProvider` so the provider can be
changed without changing D1, the API, or the frontend. FMP's free tier is
limited and may be end-of-day only (the free Basic tier is intended for
development/EOD usage); the 15-minute schedule therefore requires an
account/plan that grants the needed intraday index access. FMP currently lists
paid real-time tiers from roughly $22/month when billed annually, subject to
change. FMP's terms also
require an appropriate Data Display/Licensing Agreement for public display;
the production secret must not be provisioned until that permission is in
place. The current adapter is therefore deliberately replaceable: if the
commercial terms are not acceptable, only this provider adapter changes.
Until the secret is configured, the Worker returns `Not available` rather than
presenting old data as current. Fear & Greed is separately isolated behind
`SentimentProvider` and retains the last valid D1 observation after a temporary
provider failure.

## Development

Requires Node 20+ (Node 22 recommended).

```bash
npm ci
npm run dev
```

Quality gates:

```bash
npm run lint
npm run typecheck
npm test
npm run build
npx wrangler deploy --dry-run
```

## Project structure

```text
apps/web/src/morning-briefing/             Current Morning Briefing product UI
apps/web/src/morning-briefing/data/        Mock fallbacks separated from UI
apps/web/src/daily-briefing-pages.tsx       Retained public information pages
apps/web/worker                             Worker APIs, signed ingest and D1 read models
apps/web/worker/daily-briefings.ts          DailyBriefing publication/read helpers
apps/web/worker/x-posts.ts                  Curated X post publication/read helpers
apps/web/migrations                         D1 schema migrations
bot/bot                                     Private runtime foundation
packages/contracts                          Shared validated contracts and schemas
```

## Disclaimer

Morning Briefing provides general market research for informational and
educational purposes only. Nothing on the website is a recommendation,
solicitation or personalised assessment to buy, hold or sell a security. Verify
all data and primary sources independently.
