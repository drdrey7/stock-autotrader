# Stock Daily Briefing — Publisher Spec v1

Versioned prompt/spec for composing a `DailyBriefing` edition. The publication
boundary contract (`packages/contracts/src/daily-briefing.ts`) is authoritative
for the wire shape; this spec drives deterministic composition rules.

## Edition

- `editionType`: `pre_market` | `post_close`
- `editionDate`: calendar date of `preparedAt` in `America/New_York`
- `preparedAt`: ISO-8601 timestamp with offset; must fall on `editionDate` in NY
- `timezone`: `America/New_York`
- `example`: always `false` for published payloads

## Sources

- X accounts: versioned registry (`data/accounts.v1.json`); initially only
  `@nolimitgains`.
- X posts: collected externally (Hermes `x_search` at execution time) and passed
  as JSON input. X is used **only** as an idea source — never to verify price or
  news.
- Market data: passed as JSON input (quotes/snapshot produced by TradingView or
  equivalent provider). The pipeline never fabricates quotes.

## X ingestion rules (24h window)

- Keep posts with `created_at >= preparedAt - 24h` (exact 24h window).
- Deduplicate by post `id`; drop duplicate text when ids collide.
- Extract tickers from `$TICKER` mentions (uppercase, `[A-Z0-9.-]{1,10}`).
- Drop posts with no ticker.
- Membership gate: ticker must be a member of S&P 500 or Nasdaq-100 (current
  versioned snapshot). Out-of-universe tickers are dropped.
- Drop posts without an HTTPS `url` or a usable `created_at` timestamp.

## Potential Entry gate

An idea may become a `Potential Entry` only when ALL of:

- at least one `$TICKER` resolved to the universe;
- full quote/TA input for the symbol is present (price, change, technical,
  financial, news, risks, levels with trigger/invalidation/objective);
- `rewardRiskRatio` positive and `rewardRisk` text agrees (e.g. `2.5R` ↔ 2.5);
- source `originalTimestamp`/`collectedTimestamp` present, chronological, and
  within 26h of `preparedAt`.

Ideas without complete technical data are dropped (counted). Zero qualifying
ideas produce a valid brief with an empty `ideas` list.

## Market snapshot (fail policy)

- Requires exactly the three canonical benchmarks:
  `S&P 500` (SP:SPX), `Nasdaq-100` (NASDAQ:NDX), `VIX` (CBOE:VIX).
- Missing/invalid benchmark snapshot → do not publish a new edition (fail
  closed); emit the partial failure in the pipeline report.
- Missing X source → brief may publish with market context only (partial, no
  X ideas) — as long as the benchmark snapshot is valid.

## Composition

- `title`: `Pre-market briefing` / `Post-close briefing`
- `marketSummary`: one or two sentences summarising benchmark state.
- `market`: exactly the three canonical benchmark items (value, change, state,
  note) from the input snapshot.
- `ideas`: max 3 (`Potential Entry`), unique canonical symbols.
- `schedule`: fixed per edition — `08:30 ET` (pre_market) or `16:30 ET`
  (post_close) with a `24h X window` detail line.

## Publication

- Event type: `DAILY_BRIEFING_PUBLISHED`
- Payload: the validated `DailyBriefing` object.
- Signed with HMAC-SHA256 via the PR #3 publisher client.
- Dry-run writes the brief + operational counts to stdout/JSON without
  publishing.

## Operational counts

Report per run: posts seen, posts deduped, posts without ticker, tickers
outside universe, ideas missing data, candidates, potential entries, rejected
(reason counts), market snapshot status.
