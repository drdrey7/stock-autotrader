# Morning Briefing

Public, read-only market intelligence for S&P 500 and Nasdaq-100 investors.

## Current frontend

The approved **Morning Briefing** interface is the public product shell:

- Morning Briefing consumes the published briefing, market/status and candidate APIs;
- X Pulse consumes curated posts from the tracked X accounts;
- Earnings consumes the Cloudflare-owned `earnings_events` D1 read model;
- missing backend fields are rendered as `Not published`;
- stale or invalid backend values are never presented as live;
- the frontend refreshes silently while the backend controls publication cadence;
- there is no login, portfolio, watchlist, chat or trading action.

Routes: `/`, `/dashboard`, `/x` and `/earnings`. The public Methodology, Status
and Disclaimer routes remain available.

## Historical frontend work

PR #6 introduced the first synthetic, frontend-only product demo. PR #7 added
the validated `DailyBriefing` contract and D1 read model. PR #8 added curated X
post ingestion. PR #9 replaces that demo shell with the current live-aware
Morning Briefing frontend. The Earnings route no longer imports financial
fixtures: it only renders the Worker API response and shows `Not published`
when a value is missing. The legacy dashboard/quant read model is intentionally
outside the ownership boundary of the Earnings Engine and remains unchanged.

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
a small post-close retry window; Fear & Greed runs at 14:00 and 19:00 UTC on weekdays. The
Worker applies `America/New_York` conversion, weekends, holidays, DST and
source-date validation before writing.

The temporary zero-cost index adapter uses Yahoo Finance's public Chart HTTP
endpoint for `^GSPC`, `^NDX`, `^DJI` and `^VIX`. It requires no API key and runs
directly from the Worker. This endpoint is unofficial, has no published SLA or
guaranteed quota, may be rate-limited or change without notice, and its public
display/licensing terms must be reviewed before treating it as a permanent
commercial data source. It is acceptable here because the product needs only
four delayed/periodic context values and the adapter is explicitly temporary.

The adapter is isolated behind `MarketDataProvider`, so changing provider does
not change D1, the API, or the frontend. The Worker returns `Not available`
rather than presenting old data as current when the source is unavailable.
Fear & Greed is separately isolated behind `SentimentProvider` and retains the
last valid D1 observation after a temporary provider failure.

## Automated Earnings Engine (PR #12)

The Earnings route is owned by the Cloudflare Worker and follows:

```text
Cloudflare Cron → provider adapters → normalization → D1 → Worker API → UI
```

`earnings_events` is the only Earnings Engine write model. The legacy
`earnings` table remains a quant/screening table and is not read by
`/api/earnings`. The tracked universe is the deduplicated union of the
versioned S&P 500 and Nasdaq-100 resources in `apps/publisher/data`; it is
stored in `earnings_universe` so the resource can be replaced without editing
React components.

The calendar and consensus contracts are provider-neutral; the current
zero-cost adapter is Financial Modeling Prep's documented HTTP earnings
calendar. It supplies schedule, estimates and actuals when its free API key is
available. The official-filings adapter uses SEC EDGAR submissions, with a
descriptive `User-Agent`, retry/timeout handling and prioritization of 8-K Item
2.02, 10-Q, 10-K and 6-K filings. FMP access and free-tier limits can change,
so the adapter is isolated and replaceable; no paid provider is required.

Production must store the free provider key as a Cloudflare Worker secret:

```bash
npx wrangler secret put FMP_API_KEY
# Optional but recommended for SEC's descriptive contact header:
npx wrangler secret put SEC_USER_AGENT
```

No key, token or contact secret belongs in Git. Preview Cron is disabled by the
Worker whenever `ENVIRONMENT` is not `production`.

The daily Cron refreshes `today → today + 60 days` (with a three-day look-back
for late results); the 15-minute Cron polls only scheduled events inside the
BMO/AMC/TBD New York-time windows and also detects a provider event newly moved
onto today. Fiscal
identity (`symbol + fiscal year + normalized fiscal period`, using `Qn` when
available) prevents a provider date change from creating a duplicate.
EPS/revenue surprise and overall-result
rules live in the Worker normalization layer and use `NULL`/`Not published`
when either side is unavailable. `In Line` uses
`abs(actual - estimate) <= max(abs(estimate) * 0.5%, Number.EPSILON)`;
surprise percentage is `NULL` when the estimate is zero.

Migrations `0008_earnings_engine.sql` and `0009_earnings_identity_scope.sql` are
applied locally in CI and remotely by
the production deployment workflow before the Worker deploy. The workflow
also verifies that `earnings_events` and `earnings_universe` exist remotely.
Use `npm run db:migrate:local -w @stock-autotrader/web` for local validation;
the production migration remains CI-owned.

Cron batches D1 writes and caps SEC enrichment at 24 filings per invocation so
the free Workers subrequest budget is respected; remaining official links are
picked up by the next 15-minute/daily run. A transient provider or SEC failure
never clears the last valid event values.

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
npx --yes wrangler@4.122.0 deploy --dry-run
```

## Project structure

```text
apps/web/src/morning-briefing/             Current Morning Briefing product UI
apps/web/src/morning-briefing/data/        UI-only formatting and source adapters
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
