# History Ingestor — Alpha Vantage weekly history + split-only adjustment

Screener PR2: the **historical layer** behind the live 200-week SMA. It
bootstraps and maintains `weekly_prices` + `technical_metrics` in the shared
D1 database (`stock-autotrader-db`) from **Alpha Vantage**, split-adjusted
only (never dividend-adjusted). Live/current prices remain exclusively the
Finnhub WebSocket pipeline from PR #65 (`apps/quote-ingestor`) — this app
never provides current quotes.

```
Alpha Vantage (TIME_SERIES_WEEKLY + SPLITS)
      │  paced, per-key budgeted, resumable
      ▼
history_ingestor  ──►  D1 weekly_prices + technical_metrics
      │
      └ (weekly maintenance: refresh / reconcile splits / recompute metrics)
Cloudflare Worker /api/screener  =  technical_metrics basis + latest_quotes.price
```

## Why this layering

- **Weekly history changes once a week**, not every tick. The Worker therefore
  reads the precomputed 199-week basis (`technical_metrics`, 50 rows) instead
  of ~1000×50 `weekly_prices` rows per Screener request.
- **Split-only adjustment** matches a normal stock price chart (splits only,
  no dividends) — the canonical SMA semantic the Screener wants.
- **The live formula** (PR2 §7) is:

  ```
  SMA200W live = (sum of the 199 completed split-adjusted weekly closes
                  immediately preceding the quote's trading week
                  + current Finnhub WebSocket price) / 200
  ```

  The 199-week basis is anchored to the quote's OWN trading week (from
  `latest_quotes.provider_timestamp`, America/New_York ISO week), so the
  current week is never double-counted and the result is correct during
  market hours, post-close, weekends, Monday pre-open, holidays and
  early-close days.

## Provider contract (verified live 2026-08-19)

- `TIME_SERIES_WEEKLY?symbol=X&outputsize=full` → `Meta Data` +
  `Weekly Time Series`, ~20y of weekly buckets keyed by the week's **last
  trading day** (a Thursday when Friday is a holiday). OHLC/volume are
  strings; the newest bucket is the **in-progress** week and is dropped.
- `SPLITS?symbol=X` → `{"symbol", "data": [{effective_date, split_factor}]}`
  newest-first; `split_factor` is a decimal string (`"10.0000"`, `"1.5000"`,
  `"0.5000"` for a 1:2 reverse split).
- **Rate behaviour (free tier): 25 requests/day per key.** Back-to-back calls
  return `{"Information": ...}` (soft pacing — the client paces ~13s per key
  and backs off); daily exhaustion returns `{"Note": ...}` (hard stop).
  Two independently-obtained keys each carry their own 25/day entitlement.
  The tool NEVER rotates keys to bypass a per-key quota — it simply stops
  once every key is exhausted and resumes the next day from its checkpoint.

## Secrets

- Keys come from the runtime environment: `ALPHA_VANTAGE_API_KEYS`
  (comma-separated), `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`,
  `CLOUDFLARE_D1_DATABASE_ID` — via a systemd `EnvironmentFile` on the VPS
  (0600, owner hermes), exactly like `apps/quote-ingestor`.
- Keys are referenced **only by index**; values never appear in logs, errors,
  checkpoints, stdout or git (covered by `tests/test_secrets.py`).
- Set `HISTORY_INGESTOR_UNIVERSE` to `packages/contracts/src/core-universe.v1.json`
  (the default resolves to that path automatically).

## Commands

Run from the repo root (or `apps/history-ingestor`):

```bash
# One-shot resumable bootstrap (SPLITS before WEEKLY per symbol; idempotent
# UPSERTs; checkpoint after every symbol; stops when every key's 25/day is
# exhausted and reports exactly what remains):
python3 -m history_ingestor bootstrap

# Partial run / specific symbols / request cap / planning-only:
python3 -m history_ingestor bootstrap --limit 20 --symbols NVDA AAPL MSFT
python3 -m history_ingestor bootstrap --dry-run        # no provider calls, no D1 writes

# Weekly maintenance: refresh + split reconciliation + metrics + coverage:
python3 -m history_ingestor maintenance

# Checkpoint + D1 coverage summary:
python3 -m history_ingestor status

# Local data-quality validation of one symbol's D1 rows:
python3 -m history_ingestor validate --symbol NVDA
```

Note: a `bootstrap` subcommand runs with `PYTHONPATH=.` (the package dir) or
`python3 -m history_ingestor` from `apps/history-ingestor/`.

## What gets stored

`weekly_prices` — one row per `(symbol, week_end_date)`:
raw OHLCV as-traded, `split_adjustment_factor` (the cumulative divisor F(t) =
product of all split ratios effective strictly after that week's end),
`split_adjusted_close = raw_close / F(t)` (e.g. 400 → 4:1 → 100), `source`,
`source_fetched_at`. UPSERT-by-PK is idempotent; re-running never duplicates.

`technical_metrics` — one row per symbol with the basis the Worker combines
with the live quote:
`anchor_week` (the latest completed stored week L, `YYYY-MM-DD`),
`completed_weeks_available`, `sum_199` (199 closes ending at L),
`anchor_close` (L's close — the one-row correction term),
`closed_sma_200w` (informational chart-style SMA), `historical_data_as_of`,
`calculated_at`, `status` (`ok` / `limited` 199.. / `not_enough_history` /
`no_data`).

The Worker logic: quote week == anchor week → `(closed_sma_200w * 200 - anchor_close + price)/200`
(true 200-week basis — the naive `sum_199 - anchor_close + price` would only supply 198 prior
closes + the quote = 199 observations, which is wrong); quote week == anchor+1 → `(sum_199 + price)/200`;
anything else → honest `Unavailable`, never a fabricated SMA.

The same-week (delta 0) form only applies when a genuine 200 completed-week basis exists
(`closed_sma_200w` non-null). With exactly 199 completed weeks, there are not 199 closes strictly
before L, so it honestly reports `NotEnoughHistory`.

## Bootstrap / resume design

- Loads the canonical Core Universe **exclusively** from
  `packages/contracts/src/core-universe.v1.json` (validated: exactly 50,
  unique, sorted) — no second permanent symbol list anywhere.
- Checkpoint (`app_meta.historyBootstrapState` in D1, with a local-file
  mirror): per-key request counts for the current UTC day + per-symbol
  per-endpoint status (`splits` / `weekly` → pending | done | error).
- Resume skips done symbols (no duplicate downloads); a new day resets per-key
  counts while keeping completed symbols done — can spread across days.
- `Information` throttle → count the HTTP request, circuit-break that key for
  the rest of the run (no same-key retry storm), try other keys once. When
  every key is throttled the run stops with status `throttled`, saves the
  checkpoint, and does NOT mark the current symbol as a permanent error.
  Fairness queue prefers never-tried/pending symbols over sticky transient
  errors so head-of-line blocking cannot starve the rest of the universe.
  `Note` quota → the key is marked exhausted; when all keys are exhausted the
  run stops cleanly, saves the checkpoint and reports the remaining symbols.
- Transient network/server errors retry across keys with a small bound;
  invalid keys and unknown symbols are non-retryable. Provider messages are
  NEVER persisted as market data (strict parser). Structured attempt logs
  record `symbol/endpoint/key_index/attempt/result` without secrets.

## Weekly maintenance

`maintenance` refetches the full series per symbol (one request each at this
scale), reconciles split history by recomputing factors from the FRESH split
list and rewriting every row whose factor/adjusted close changed (a new or
changed split rewrites the whole affected history — no mixed adjustment
regimes), recomputes `technical_metrics`, verifies coverage (row counts,
week-sequence gaps via ISO-week Mondays, `<199` weeks) and writes a report to
`app_meta.historyMaintenanceReport`. It respects the same per-key quota
policies, so a full pass can spread across days under free-tier limits.

### systemd deployment (documented — install requires root)

Production uses three timers, all explicitly UTC:

- bootstrap: `06:00 UTC` daily, temporary until initial coverage completes;
- maintenance: `07:00 UTC` daily, permanent long-term path;
- due-split: `13:10 UTC` Tue-Sat, zero-provider reconciliation.

Provision the existing secret files first:

- `/etc/stock-autotrader/alpha-vantage.env`
- `/etc/stock-autotrader/cloudflare.env`

They remain outside Git and are never modified by the installer. Then stop any
currently active history-ingestor timers in a planned maintenance window and
install the packaged units:

```bash
sudo systemctl stop history-ingestor-bootstrap.timer history-ingestor-maintenance.timer history-ingestor-due-split.timer
sudo ./deploy/install-history-ingestor-root.sh
```

The installer only validates prerequisites, installs the six systemd unit files
and runs `daemon-reload`. It deliberately does **not** enable or start timers,
so installation itself cannot consume Alpha Vantage quota. Activate explicitly
when ready:

```bash
sudo systemctl enable history-ingestor-bootstrap.timer history-ingestor-maintenance.timer history-ingestor-due-split.timer
sudo systemctl start history-ingestor-bootstrap.timer history-ingestor-maintenance.timer history-ingestor-due-split.timer
sudo systemctl list-timers --all | grep history-ingestor
```

Bootstrap is resumable and becomes a zero-provider no-op once complete; at that
point disable its temporary timer with:

```bash
sudo systemctl disable --now history-ingestor-bootstrap.timer
```

Service ordering serializes bootstrap → maintenance → due-split when persistent
timers catch up together after an outage. For production manual runs, prefer
`systemctl start history-ingestor-<service>` rather than invoking the Python
module directly so the same ordering rules apply.

## Tests

```bash
cd apps/history-ingestor && python3 -m unittest discover -s tests -v    # 149 tests
cd <repo root> && ruff check .                                            # lint
```

Covers: NY/ISO week helpers (holiday weeks, year boundaries, DST), strict
WEEKLY/SPLITS parsing (garbage, throttle, quota, invalid-key, impossible OHLC,
NaN), split-only adjustment (2:1, 3:1, 4:1, 10:1, fractional 3:2, reverse,
sequential), technical-metrics windows (199/200 boundaries), D1 upsert
idempotency/chunking/error handling, checkpoint resume + day rollover, the
provider (pacing, quota exhaustion, invalid-key skip, round-robin, no
tight-loop retries), bootstrap (splits-before-weekly, resume, quota stop,
dry-run), maintenance (split reconciliation, coverage, anomalies) and
secret-leak assertions.

## Rollback

No destructive rollback: `weekly_prices` / `technical_metrics` are additive
tables (migration `0015_weekly_history.sql`). If PR2 needs to be disabled the
Worker/API simply stops exposing the new SMA fields; the tables can stay. The
`latest_quotes` / Finnhub WebSocket pipeline is untouched by this app.
