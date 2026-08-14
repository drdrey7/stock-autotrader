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

The Worker schedules are UTC because Cloudflare Cron Triggers are UTC.
Production declares only two trigger entries because Cloudflare Workers Free
applies its cron-trigger limit at the account level: `*/15 * * * *` and
`0 6 * * *`. The 15-minute dispatcher runs the Earnings monitor every time,
lets Market Context apply its existing market-window logic, and runs Fear &
Greed only at 14:00 and 19:00 UTC on weekdays. The 06:00 UTC entry runs
Earnings calendar/backfill. The Worker applies `America/New_York` conversion,
weekends, holidays, DST and source-date validation before writing.

The combined 14:00/19:00 invocation is budgeted conservatively below the
Workers Free 50-external-subrequest limit. With two attempts per request and a
16-filing lookup cap, the worst SEC-calendar path is `2` metadata + `6` full
index + `32` filing + `4` Yahoo + `1` CNN = `45` requests, leaving `5` headroom.
The FMP-calendar path is `39`; the 06:00 calendar-only paths are `40` (SEC)
or `36` (FMP). D1 reads/writes are not counted as external provider requests.

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

The calendar and consensus contracts are provider-neutral. SEC EDGAR is the
default zero-cost adapter: its quarterly full indexes backfill filed 10-Q,
10-K and 6-K events, while submissions enrich relevant 8-K Item 2.02, 10-Q,
10-K and 6-K links. SEC does not publish future earnings schedules or analyst
consensus, so those fields remain `NULL`/`Not published` unless the optional
FMP calendar adapter is configured. No synthetic dates, estimates or Beat/Miss
values are created. FMP is isolated behind the same adapter interfaces and is
never a required dependency; its free-tier access can change.

An optional calendar/consensus key may be stored as a Cloudflare Worker secret:

```bash
npx wrangler secret put FMP_API_KEY
# Optional but recommended for SEC's descriptive contact header:
npx wrangler secret put SEC_USER_AGENT
```

No key, token or contact secret belongs in Git. PR previews use one permanent
`stock-autotrader-preview` Worker with no D1, KV, R2, Durable Object, service or
secret bindings and no cron triggers. Its same-origin `/api/*` handler proxies
only public GET/HEAD requests to the production Worker; branch commits are
uploaded as isolated Worker versions by Cloudflare Workers Builds. Isolated
backend staging/D1 previews remain a future follow-up and are intentionally
outside PR #13.

The daily Cron refreshes `today - 90 days → today + 60 days`; the 15-minute Cron polls only scheduled events inside the
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

Cron batches D1 writes and caps SEC enrichment at 16 filings per invocation so
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

PR preview setup and its security boundary are documented in
[`docs/PR13_PR_PREVIEWS.md`](docs/PR13_PR_PREVIEWS.md).

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
