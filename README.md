# Morning Briefing

Public, read-only market intelligence for a manually curated Core stock
universe and separate market-index context.

## Current frontend

The approved **Morning Briefing** interface is the public product shell:

- Morning Briefing consumes the published briefing, market/status and candidate APIs;
- X Pulse consumes curated posts from the tracked X accounts;
- Earnings consumes the Cloudflare-owned `earnings_events` D1 read model;
- missing Earnings backend fields are rendered as `N/A`;
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
fixtures: it only renders the Worker API response and shows `N/A`
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
The Finnhub-calendar path is `39`; the 06:00 calendar-only path is `36`
(SEC metadata + one bulk Finnhub request + 16 filing lookups). D1
reads/writes are not counted as external provider requests.

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

## Automated Earnings Engine (Issue #19)

The Earnings route is owned by the Cloudflare Worker and follows:

```text
Cloudflare Cron → provider adapters → normalization → D1 → Worker API → UI
```

`earnings_events` is the only Earnings Engine write model. The legacy
`earnings` table remains a quant/screening table and is not read by
`/api/earnings`.

### Core Stock Universe

The versioned baseline is [`packages/contracts/src/core-universe.v1.json`](packages/contracts/src/core-universe.v1.json).
It contains only the version and the deterministic list of 50 uppercase
symbols. `npm run validate:core-universe` and the build fail loudly on malformed
configuration, duplicates, invalid symbols or an incorrect v1 count.

The runtime flow is:

```text
Git Core Universe → Core sync → D1 earnings_universe → public stock-specific reads
```

`earnings_universe` is the D1 lifecycle model. Core sync activates configured
symbols with `source = 'core'`, preserves `added_at` for existing members,
records `removed_at` when a symbol is removed, and reactivates rows safely if a
symbol is later re-added. Historical `earnings_events` rows are never deleted.
Only active D1 universe members are publicly surfaced on stock-specific reads.

To add a stock today:

1. Edit the JSON `symbols` list.
2. Run `npm run validate:core-universe` and the tests.
3. Open, merge and deploy the PR.
4. Let the normal calendar sync reconcile D1.

To remove a stock, use the same process; its row becomes inactive and its
historical data remains.
Core is manually curated in this phase. S&P 500/Nasdaq-100 membership no
longer defines the site stock universe; their snapshots remain only where
index-specific features legitimately need them. X/Trending dynamic membership
is not implemented. A future authenticated Admin page can write the same D1
`earnings_universe` model while runtime readers remain unchanged.

The calendar and consensus contracts are provider-neutral. Finnhub is the
production primary for the bulk earnings calendar: scheduled dates, BMO/AMC/
TBD timing, fiscal quarter/year and EPS/revenue estimates and actuals. SEC
EDGAR remains the official enrichment provider for company metadata, CIKs,
filing verification, report links and acceptance timestamps. No synthetic
dates, estimates or Beat/Miss values are created. The existing FMP adapter is
optional compatibility code and is not required for production Earnings.

The Finnhub key is stored only as a Cloudflare production Worker secret:

```bash
npx wrangler secret put FINNHUB_API_KEY
# SEC also uses this safe configured/default descriptive contact header:
npx wrangler secret put SEC_USER_AGENT
```

No key, token or contact secret belongs in Git. PR previews use one permanent
`stock-autotrader-preview` Worker with no D1, KV, R2, Durable Object or secret
bindings and no cron triggers. Its only service binding is
`PRODUCTION_API → stock-autotrader-web`; the same-origin `/api/*` handler
proxies only public GET/HEAD requests to that production Worker. Branch
commits are uploaded as isolated Worker versions by Cloudflare Workers Builds.
Isolated backend staging/D1 previews remain a future follow-up and are
intentionally outside this issue.

The daily Finnhub request refreshes `today - 30 days → today + 60 days`, matching
the useful Free-plan historical range while retaining older rows already in
D1. It uses one bulk date-range request, filters the response to the active
Core universe, and enriches a bounded number of events through SEC. The 15-minute
Cron polls only active events inside the BMO/AMC/TBD New York-time windows and
does at most an hourly empty-calendar discovery poll. Fiscal
identity (`symbol + fiscal year + normalized fiscal period`, using `Qn` when
available) prevents a provider date change from creating a duplicate.
EPS/revenue surprise and overall-result
rules live in the Worker normalization layer and use `NULL`/`N/A` when either
side is unavailable. An actual greater than, less than or exactly equal to an
estimate is a Beat, Miss or Met respectively; surprise percentage is `NULL`
when the estimate is zero.

Migrations `0008_earnings_engine.sql`, `0009_earnings_identity_scope.sql` and
`0010_core_universe_runtime.sql` are
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
[`docs/PR13_PR_PREVIEWS.md`](docs/PR13_PR_PREVIEWS.md). The public `/api/*`
routes are documented in [`docs/api.md`](docs/api.md).

## Project structure

```text
apps/web/src/morning-briefing/             Current Morning Briefing product UI
apps/web/src/morning-briefing/data/        UI-only formatting and source adapters
apps/web/src/daily-briefing-pages.tsx       Retained public information pages
apps/web/worker                             Worker APIs, signed ingest and D1 read models (routing only)
apps/web/worker/dashboard.ts                Dashboard/source-health read model + scoped table readers
apps/web/worker/daily-briefings.ts          DailyBriefing publication/read helpers
apps/web/worker/x-posts.ts                  Curated X post publication/read helpers
apps/web/worker/earnings/                   Automated Earnings Engine (providers, logic, D1 storage)
apps/web/migrations                         D1 schema migrations
bot/bot                                     Private runtime foundation (scan/signal engine not yet wired up — see bot/README.md)
packages/contracts                          Shared validated contracts and schemas
```

## Disclaimer

Morning Briefing provides general market research for informational and
educational purposes only. Nothing on the website is a recommendation,
solicitation or personalised assessment to buy, hold or sell a security. Verify
all data and primary sources independently.
