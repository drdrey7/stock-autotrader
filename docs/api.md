# Public API reference

`apps/web/worker/index.ts` is the entire public surface. It is **GET/HEAD/OPTIONS-only**
except the one signed write endpoint below, unauthenticated, and every response is
`application/json`, cached `public, max-age=60` — except `/healthz/sources`, which
is `no-store` (see below: it exists for an external monitor, so it must never
serve a stale cached verdict). There is no admin route and no broker/trading
action anywhere in this API.

Schemas referenced below live in [`packages/contracts`](../packages/contracts); the
Worker validates every response it builds against them before serving, so a
malformed payload never leaves the API. The frontend trusts that contract and
does not re-validate on receipt — `fetchJson()` in `MorningBriefingData.tsx`
casts the parsed JSON straight to its expected type, so the validation
boundary is server-side only. See `packages/contracts/src/dashboard.ts` for
the dashboard/market-data shapes and `packages/contracts/src/daily-briefing.ts`
for the briefing shape.

## `GET /healthz`

Liveness only — does not touch D1.

```json
{ "ok": true, "time": "2026-08-14T12:00:00.000Z" }
```

## `GET /healthz/sources`

For an external uptime monitor. Unlike `/healthz`, this touches D1 and reports
whether the two critical public data sources — `market` and `earnings` — are
effectively healthy, not just whether the Worker is up. `cache-control: no-store`
(never cached, so every poll reflects live state).

The verdict is computed from the runtime's own canonical health model
(`buildSources()` + `buildMarketContextHealth()` in `worker/dashboard.ts`) —
there is no second, parallel freshness/session computation in this endpoint:

- `market` is down when its canonical state is `Unavailable`/`Error` (no valid
  data: never collected, corrupt/future timestamps, or a failed read model),
  when the canonical Market Context health record carries a runtime failure
  (`lastError` from the last `degraded` collection run surfaces verbatim as
  `sources.market.error`, distinguishing an active failure from the ordinary
  prior-session marker), or when the required index set (SPX, NDX, DJI, VIX)
  is incomplete. A complete set from a prior NY session date — `Cached` with
  only the "incomplete or from a prior session" marker — is NOT down: that is
  a closed market (overnight/weekend/holiday), not an outage. Because the
  runtime writes all-or-nothing complete sets and records every failed run in
  `marketContextHealth`, an intraday provider failure keeps paging (the
  `lastError` persists) until a successful run actually replaces the data —
  it never "heals" merely because the session window closed.
  One check covers the no-error gaps the runtime cannot record itself (a
  collection job that never runs — dead scheduler/trigger — or a provider
  answering 200 with frozen quotes): each required index's own `updatedAt`
  is checked against minutes of *actual session time* since it was written
  (regular + post-close, via the canonical `marketCollectionWindow()`;
  45 minutes = three missed 15-minute ticks). The count is monotonic —
  session time never un-counts when the window closes — so an incident
  flagged mid-session stays flagged through the close and across the
  weekend until fresh data arrives, while a set genuinely fresh at Friday's
  close accrues at most the post-close window's minutes, under the
  threshold. A late-session freeze that misses the closing print keeps
  accumulating through the post-close window and is flagged by ~16:45 ET.
  A 96h absolute backstop catches outages spanning implausibly long closed
  stretches.
- `earnings` is down unless the canonical engine state is `HEALTHY`.
  `engineState` is derived by `buildSources()` from the live
  `earnings_universe` row count + last success + error + the canonical 26h
  stale window, so an empty/invalid universe can never read as healthy off a
  cached timestamp (`UNINITIALIZED` always pages), and an active collection
  failure (`DEGRADED`) or a missed daily sync (`STALE`) always pages.

Read-model failures unrelated to `market`/`earnings` (a broken `research` or
`daily_briefings` read, say) fall back to safe defaults rather than aborting
the check — only a failure in the market/earnings read path itself can make
this endpoint report unhealthy for a reason other than actual staleness.

All sources are included in the body for diagnostics, but only `critical`
gates the status code — a degraded `opportunities` (the scan engine is a
known, long-term stub — see `bot/README.md`) or `quickStats` (a permanent
placeholder) never pages on their own.

```json
{
  "ok": false,
  "time": "2026-08-14T21:00:00.000Z",
  "critical": ["market", "earnings"],
  "down": ["market"],
  "sources": { "market": { "state": "Cached", "error": "SPX: provider HTTP 429", "...": "..." }, "...": "..." }
}
```

A hard store failure fails closed the same way: `503` with `{"ok": false, "error": "read_model_unavailable"}` — including when the critical Market Context health record itself cannot be read or parsed (`readMarketContextHealthStrict`), so a persisted provider error is never silently invisible. A degraded critical read (empty read model) fails closed with `503` and the per-source diagnostic instead.

## `GET /api/status`

The composed read model behind the Morning Briefing frontend: the dashboard read
model (see `dashboard()` in `worker/dashboard.ts`) plus briefing status, live market
indices/sentiment, and per-source freshness health (`Live` / `Stale` / `Cached` /
`Error` / `Unavailable`, never fabricated). On a partial backend failure this still
returns `200` with every affected source fail-closed to `Unavailable`/`Error` rather
than silently reusing stale data; a `500` only happens if the dashboard read model
itself is unavailable on both the primary and retry attempt.

## `GET /api/briefs/latest?editionType=pre_market|post_close`

Most recent published Daily Briefing. `editionType` is optional; omit it for the
latest of either edition. `404 {"error":"brief_not_found"}` if none has been
published yet; `400 {"error":"invalid_edition_type"}` for an unrecognized value.

## `GET /api/briefs/:editionDate/:editionType`

A specific edition by date (`YYYY-MM-DD`, `America/New_York` calendar date) and
type. Same 404/400 semantics as above (`invalid_briefing_identifier` for a
malformed date or type).

## `GET /api/x/posts?author=&symbol=&limit=`

Curated X posts collected by the publisher. All params optional; `symbol` is
uppercased before matching; `limit` defaults to 50 and is clamped to `[1, 200]`.
`503 {"error":"x_store_unavailable"}` on a store failure.

## `GET /api/earnings?from=&to=&symbol=&status=`

Rows from the Automated Earnings Engine's `earnings_events` table — **not** the
legacy `earnings` table embedded in `/api/status`'s dashboard payload (see the
README's "Automated Earnings Engine" section for why the two are separate).

- `from`, `to`: `YYYY-MM-DD`. Default window is year-to-date through the rolling
  60-day forward window (`EARNINGS_WINDOW_DAYS`). `to` may not precede `from`, and
  the span may not exceed 450 days (`EARNINGS_QUERY_MAX_DAYS`).
- `symbol`: canonical ticker, case-insensitive.
- `status`: one of `scheduled`, `reported`, `cancelled`, `unknown`.
- Any invalid value → `400 {"error":"invalid_earnings_query"}`.
- Store failure → `503 {"error":"earnings_store_unavailable"}`.

Response: `{ events: EarningsEngineEvent[], summary: { today, thisWeek, next30Days }, from, to }`.

## `GET /api/market-data`

The published quant-screening market snapshot (`MarketDataSnapshot`) — universe
counts, SPY/QQQ benchmark bars, provider status. Returns the conservative
`offline` default rather than an error if nothing has ever been published or the
store is unavailable. This is a different, narrower concept than:

## `GET /api/market-context`

Live index quotes (SPX/NDX/DJI/VIX) and CNN Fear & Greed sentiment, collected by
the Worker's own Cron triggers (see `worker/market-context.ts`). This is what
`/api/status`'s `market`/`sentiment` fields surface; this route exposes the same
read model directly.

## `GET /api/stocks/:symbol`

The latest scan's candidate for one ticker (case-insensitive), with its decision
reasons. `404 {"error":"Not found"}` if the symbol isn't in the latest scan.

## `GET /api/portfolio/shadow`

`{ portfolio, positions }` — shadow-portfolio state and open positions only.

## `GET /api/strategies`

`StrategySummary[]` — the strategy registry only.

## `POST /ingest/events`

The one write path, used only by the VPS publisher/bot — not part of the public
read surface. HMAC-SHA256 signed (`X-Ingest-Signature: sha256=<hex>` over
`${X-Ingest-Timestamp}.${raw body}`, keyed by `INGEST_SECRET`), 5-minute replay
window, 1 MB body cap, per-`event_id` idempotency. See `worker/ingest.ts` for the
full event schema.
