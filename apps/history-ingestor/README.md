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
      ├ weekly maintenance: WEEKLY refresh + recompute metrics (priority)
      └ separate reconcile-splits: low-frequency SPLITS discovery
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
  Two independently-obtained keys each carry their own 25/day entitlement,
  giving a nominal aggregate of **50 requests/day total**. The tool NEVER
  rotates keys to bypass a per-key quota — it simply stops once every key is
  exhausted and resumes the next day from its checkpoint.

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
# UPSERTs; exact provider HTTP cap; reports exactly what remains):
python3 -m history_ingestor bootstrap

# Partial run / specific symbols / request cap / planning-only:
python3 -m history_ingestor bootstrap --limit 4 --symbols NVDA AAPL MSFT
python3 -m history_ingestor bootstrap --dry-run        # no provider calls, no D1 writes

# Weekly maintenance: WEEKLY refresh + metrics (PRIORITY provider worker;
# never fetches SPLITS — decoupled):
python3 -m history_ingestor maintenance

# LOW-FREQUENCY provider SPLITS reconciliation (decoupled from weekly):
python3 -m history_ingestor reconcile-splits

# Daily zero-provider split application (apply due future-dated splits):
python3 -m history_ingestor apply-due-splits

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

The Worker logic is intentionally availability-first without sacrificing split
safety:

- quote week == anchor week → `(closed_sma_200w * 200 - anchor_close + price)/200`;
- quote week == anchor+1 → `(sum_199 + price)/200`;
- quote week > anchor+1 → if a previously-valid `closed_sma_200w` exists, serve
  that **last-known-good** value and compute live distance from the current quote;
- quote week < anchor → `Unavailable` (inconsistent data);
- any confirmed quote/history split-scale mismatch → `Unavailable` before any
  last-known-good fallback is considered;
- insufficient completed history → `NotEnoughHistory` (`N/A`).

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
- The residual bootstrap has an independent **exact HTTP debit counter** for the
  UTC day. `BootstrapBudgetLedger` increments/persists it at the provider ledger
  boundary on every real request, including `Information`/`Note` and an
  internal second-key retry. A service/process restart therefore cannot reset
  or double-spend the configured bootstrap daily cap (default 6).
- `--limit` is an additional per-invocation bound and can only reduce the
  bootstrap daily cap; it cannot bypass it.
- Resume skips done symbols (no duplicate downloads); a new UTC day resets
  provider/day counters while keeping completed symbols done.
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

`maintenance` is the **priority** provider worker. It refetches
`TIME_SERIES_WEEKLY` per symbol, adjusts from the DURABLE `split_events` store,
upserts only changed/new weekly rows, recomputes `technical_metrics`, verifies
coverage and writes a report to `app_meta.historyMaintenanceReport`. It NEVER
fetches `SPLITS` — split reconciliation is a separate, low-frequency
responsibility (`reconcile-splits`), and the daily `apply-due-splits` is the
zero-provider application of due future-dated splits. **The weekly SMA refresh
never depends on split reconciliation and is never blocked by it.**

`maintenance` respects the same per-key quota policies, so a full pass can
spread across days under free-tier limits.

### LAST-KNOWN-GOOD (preserved SMA)

Once a symbol has a valid 200-week SMA basis (`technical_metrics.closed_sma_200w`),
that basis is never discarded. If a weekly refresh lags (the anchor week is one
or more weeks behind the quote's week), the Worker/API/UI keeps serving the last
valid SMA value — it is never nulled or flipped to `Unavailable` purely because
the newest week is missing. The stale state remains observable internally via
`historical_data_as_of` / `sma200wAsOf`, but the user simply sees the last
available value. Only symbols that never accumulated a valid 200-week basis
report `NotEnoughHistory` (`N/A`). A confirmed split-scale mismatch remains
`Unavailable`; stale fallback never overrides split safety.

### systemd deployment (documented — install requires root)

Production uses four timers, all explicitly UTC. Provider work is ordered so
the weekly SMA refresh always has first claim on quota:

- **maintenance: `*-*-* 07:00 UTC`** daily, effectively weekly (PRIORITY over
  bootstrap). Monday refreshes the just-closed week; Tue–Sat are automatic
  catch-up and no-op once the cycle is complete.
- **bootstrap: `*-*-* 08:00 UTC`** daily, residual, runs AFTER maintenance,
  exact HTTP request-capped (default 6/day).
- **reconcile-split: `Tue..Sat *-*-* 09:00 UTC`** provider SPLITS discovery in
  five durable residual slices, maximum 10 requests per invocation. Ten calls
  per day across five residual days cover the 50-symbol universe once per
  normal week. The durable cursor resumes unfinished work rather than starting
  over. `Persistent=false` prevents outage catch-up from racing maintenance.
- **due-split: `Tue..Sat 13:10 UTC`** zero-provider application of stored rules.

Rationale: the 200W SMA basis only changes when a new week closes, and Monday
maintenance can legitimately consume essentially the whole two-key free-tier
budget (~50 requests for 50 symbols). SPLITS reconciliation therefore does NOT
run Monday. Tue–Sat maintenance still gets first chance to finish any carryover;
only afterwards can the capped bootstrap and capped reconciliation slice consume
residual quota.

Provision the existing secret files first:

- `/etc/stock-autotrader/alpha-vantage.env`
- `/etc/stock-autotrader/cloudflare.env`

They remain outside Git and are never modified by the installer. Production
code lives under `/opt/stock-autotrader`; development checkouts under
`/home/hermes/projects/...` must not be used as systemd `WorkingDirectory`.

For routine production updates, use the deterministic procedure in
`deploy/DEPLOY.md`. The privileged installer is launched from a sanitized
environment and installs the root-owned auto-disable helper plus **nine** unit
files. It validates staged units first, snapshots timer and destination state,
quiesces active timers, installs, runs `daemon-reload`, then restores each
timer's exact prior enablement/activity state.

The installer is transactional: if a failure occurs after quiescing, it
restores the previous helper/unit files and best-effort restores timer state.
An active timer that cannot be stopped causes an immediate abort. Masked or
unsupported timer states also fail closed.

On a **fresh installation**, explicitly enable/start the timers you want only
after reviewing the schedules:

```bash
sudo systemctl enable history-ingestor-bootstrap.timer history-ingestor-maintenance.timer history-ingestor-reconcile-split.timer history-ingestor-due-split.timer
sudo systemctl start history-ingestor-bootstrap.timer history-ingestor-maintenance.timer history-ingestor-reconcile-split.timer history-ingestor-due-split.timer
sudo systemctl list-timers --all | grep history-ingestor
```

Bootstrap is resumable. A successful bootstrap triggers the separate
`history-ingestor-bootstrap-maybe-disable.service` through systemd `OnSuccess=`.
That root-only completion gate has no provider/D1 `EnvironmentFile`; it drops
to `hermes` before loading the existing env files and running read-only
`history_ingestor status`, then parses the JSON with isolated Python. Only when
`bootstrap_done=50`, `bootstrap_pending=0`, and `universe_total=50` does root
run the idempotent `systemctl disable --now history-ingestor-bootstrap.timer`.
Maintenance, reconcile-split and due-split are never touched by the completion
gate.

Service ordering is maintenance → bootstrap → reconcile-split on reconciliation
days, with due-split later and zero-provider. Reconciliation is non-persistent,
so outage catch-up cannot let it jump ahead of a due maintenance run. For
production manual runs, prefer `systemctl start history-ingestor-<service>`
rather than invoking the Python module directly so the same locking/environment
rules apply.

## Tests

```bash
cd apps/history-ingestor && python3 -m unittest discover -s tests -v
cd <repo root> && ruff check .
```

Covers: NY/ISO week helpers (holiday weeks, year boundaries, DST), strict
WEEKLY/SPLITS parsing (garbage, throttle, quota, invalid-key, impossible OHLC,
NaN), split-only adjustment, technical-metrics windows, D1 upsert
idempotency/chunking/error handling, checkpoint resume + UTC-day rollover,
provider pacing/quota/throttle behavior, exact bootstrap HTTP budgeting across
internal key retries and process restarts, bootstrap resume, maintenance
WEEKLY-first behavior, independent reconcile state, filtered reconcile safety,
last-known-good SMA and secret-leak assertions.

## Rollback

No destructive rollback: `weekly_prices` / `technical_metrics` are additive
tables (migration `0015_weekly_history.sql`). If the SMA feature needs to be
disabled the Worker/API can stop exposing the fields; the tables can stay. The
`latest_quotes` / Finnhub WebSocket pipeline is untouched by this app.
