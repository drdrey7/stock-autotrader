# Public API reference

`apps/web/worker/index.ts` is the entire public surface. It is **GET/HEAD/OPTIONS-only**
except the one signed write endpoint below, unauthenticated, and every response is
`application/json` with `cache-control: public, max-age=60`. There is no admin route
and no broker/trading action anywhere in this API.

Schemas referenced below live in [`packages/contracts`](../packages/contracts); the
Worker validates every response it builds against them before serving, and the
frontend validates every response it fetches against the same schema — see
`packages/contracts/src/dashboard.ts` for the dashboard/market-data shapes and
`packages/contracts/src/daily-briefing.ts` for the briefing shape.

## `GET /healthz`

Liveness only — does not touch D1.

```json
{ "ok": true, "time": "2026-08-14T12:00:00.000Z" }
```

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

Response: `{ events: EarningsEngineEvent[], summary: { today, thisWeek, next60Days }, from, to }`.

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
