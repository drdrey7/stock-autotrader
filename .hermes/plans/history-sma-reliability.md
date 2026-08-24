# HISTORY SMA RELIABILITY — plan (2026-08-24)

Branch: `fix/history-sma-reliability` (base origin/main 5ffa953).

Goal: keep 200W SMA **always visible** once it exists; last-known-good;
maintenance WEEKLY-priority over bootstrap; splits decoupled; minimal provider
requests.

## Root cause (confirmed in code)

1. **Worker** `apps/web/worker/sma/metrics.ts` line 93-103: `delta = quoteWeek - anchorWeek`;
   when `delta > 1` (anchor 1+ week stale) it returned `Unavailable`. Today 36 symbols sit at
   `anchor_week=2026-08-14`; quote week W35 -> delta 2 -> `Unavailable` -> `—` in UI.
2. **maintenance.py** `run()` ran WEEKLY only when `phase()=="weekly"`, i.e. only after ALL
   symbols' splits were `done`. SPLITS phase cost ~50 provider requests. Bootstrap (06:00)
   exhausted the 50/day before maintenance (07:00) -> SPLITS never completed -> WEEKLY never
   ran -> anchor never rolled forward.

## Existing pieces that already help

- `apply-due-splits` = daily ZERO-provider split application (reading stored `split_events`). Already separate + correct.
- `technical_metrics` keeps `closed_sma_200w`, `sum_199`, `anchor_close`, `status` per symbol; D1 is additive.
- `provider.py` circuit breaker / pacing / quota already sound.

## Changes

### A. Worker last-known-good — `apps/web/worker/sma/metrics.ts`

When `delta > 1` (anchor stale because weekly refresh lagged), if a previously-valid closed SMA exists, serve it instead of `Unavailable`:

- If `metrics.closed_sma_200w != null` -> serve `closed_sma_200w` as `sma200w`, compute distance `(price/sma - 1)*100`, classify Above/Near/Below. HistoryWeeks/AsOf carried.
- Else -> fall to `NotEnoughHistory` (never had valid basis) — honest.
- **Split-scale mismatch is checked BEFORE the delta>1 branch** and always stays `Unavailable`; last-known-good never overrides it.
- `delta < 0` (quote older than basis) stays `Unavailable` (inconsistent data).

Tests: update the "maintenance data gap" test to last-known-good; add regression for split-scale mismatch with delta>1 (Unavailable, not stale value).

### B. Decouple SPLITS from maintenance — `maintenance.py` + `maintenance_state.py`

- `maintenance.run()` drops the SPLITS phase entirely. It becomes **WEEKLY-priority**: fetch TIME_SERIES_WEEKLY -> adjust from stored `split_events` (D1, no provider) -> upsert changed rows -> recompute metrics. Never blocked by splits status.
- `phase()` in `maintenance_state.py`: drop the "splits" gating; a symbol with weekly `error` is treated as unfinished weekly work (retried within the cycle). Cycle = { weekly, metrics } only. `phase()` returns "weekly" while any weekly/metrics pending or error, else "complete".
- Keep `apply_due_splits` as the separate zero-provider daily split application (no duplication).
- Provide a dedicated low-frequency **provider SPLITS reconciliation** path separate from weekly (see D) so new splits are still discovered without blocking WEEKLY.

### C. Bootstrap residual budget — `bootstrap.py` + cli.py + service

- Bootstrap keeps honest 47/50 checkpoint.
- Add config `bootstrap_max_requests_per_day` (default 6), a HARD cap.
- **Enforce the cap immediately before every provider call** (SPLITS, legacy split backfill, WEEKLY) via an inner budget check — a single symbol can never exceed the cap mid-iteration.
- **`--limit` is clamped** to the cap (`effective = min(limit, cap)`); it can never bypass it. Lower explicit limits are respected; `maybe-disable` untouched (still 50/50).

Tests: cap=1 + explicit large limit => exactly 1 request; limit below cap respected; limit above cap clamped; no explicit limit uses default.

### D. Low-frequency SPLITS reconciliation — NEW `reconcile-splits` command

- New CLI subcommand `reconcile-splits`: fetches provider SPLITS per symbol (bounded, quota-aware), compares vs durable split_events; on change rewrites that symbol's history + metrics.
- **`--dry-run` is provider-free** (plan only, zero calls / zero D1 writes).
- **Progress is persistent**: each reconciled symbol is marked `splits=done` in the durable maintenance store (saved every symbol). A capped run leaves unprocessed symbols pending; the next run SKIPS done symbols and resumes. Status is `partial` until every selected symbol is done — completion reads the durable STORE, not the per-run report.
- Reuses `_reconcile_splits` / `_rewrite_history_from_stored`. `_rewrite_history_from_stored` now reports `metrics_updated=True` on success.
- No overlap with `apply-due-splits` (zero-provider daily).
- Default cadence: weekly **Monday 09:00 UTC**, `Persistent=false`.

Tests: dry-run zero provider; progress persists across capped runs; done symbols never re-fetched; changed split reports metrics_updated.

### E. systemd cadence (all UTC, no overlap)

- **maintenance.timer**: `*-*-* 07:00 UTC` daily, effectively weekly (Monday refresh; Tue–Sat noop when complete). PRIORITY over bootstrap.
- **bootstrap.timer**: `*-*-* 08:00 UTC` daily, residual, AFTER maintenance.
- **reconcile-split.timer**: `Mon *-*-* 09:00 UTC`, `Persistent=false` (after maintenance/bootstrap; never preempts them).
- **due-split.timer**: `Tue..Sat 13:10 UTC` — unchanged (zero-provider daily).
- Ordering: maintenance `After=network-online`; bootstrap `After=maintenance`; reconcile-split `After=maintenance`; due-split last.
- No two provider-fetching timers share a UTC slot -> maintenance never starves.
- `Persistent=false` on reconcile-split guarantees a missed run is never auto-caught-up into maintenance's window.

### F. Installer / fresh install — add the new reconcile-split unit

- `install-history-ingestor-root.sh`: reconcile-split.{service,timer} in UNITS/SERVICES/TIMERS. Transactional behavior unchanged.
- **Fresh install enables all four timers** (maintenance, bootstrap, reconcile-split, due-split).

## Tests (mock provider, no real calls)

Python (`apps/history-ingestor/tests`):

- maintenance weekly runs without any SPLITS provider call; not blocked when splits pending.
- previously-valid SMA preserved in D1 when a WEEKLY fetch fails (row/metrics not nulled).
- bootstrap residual budget: cap enforced before every provider call; `--limit` clamped.
- reconcile-splits: dry-run zero provider; persistent progress across capped runs; changed split rewrites only that symbol; metrics_updated reported.
- empty split events scenario runs weekly cleanly.
- existing circuit-breaker/quota/pacing tests unchanged (no regression).
- no real Alpha Vantage calls in tests (FakeProvider).

Frontend/TS:

- `metrics.test.ts`: last-known-good delta>1; NotEnoughHistory distinct; split-scale mismatch with delta>1 stays Unavailable.
- stock-detail read-model: previously-valid SMA stays exposed when anchor stale.
- `ScreenerTable.smaCell` unchanged (value when `sma200w` non-null; NotEnoughHistory tooltip).

## Validation sequence

```bash
# Python tests + lint
cd apps/history-ingestor && python3 -m unittest discover -s tests -v
cd <repo root> && ruff check apps/history-ingestor

# Web tests / lint / typecheck / build (from apps/web)
cd apps/web && npm run lint && npm run typecheck && npm test && npm run build

# systemd-analyze verify (paths resolve from the repository root)
systemd-analyze verify apps/history-ingestor/deploy/*.service apps/history-ingestor/deploy/*.timer

# bash -n installers/scripts
bash -n apps/history-ingestor/deploy/install-history-ingestor-root.sh

# Secret scan (if the repo has one configured)

# Post-merge read-only D1 smoke (from apps/web)
cd apps/web && npx wrangler d1 execute stock-autotrader-db --remote --command="SELECT symbol, anchor_week, historical_data_as_of, closed_sma_200w, status FROM technical_metrics WHERE closed_sma_200w IS NOT NULL ORDER BY historical_data_as_of ASC LIMIT 20;"
```

## Out of scope (explicit)

- No manual prod D1 edits; no real provider calls during dev; no quota/plan/keys changes; no fundamentals/X Pulse; no frontend redesign beyond last-known-good/N/A; no weakening of maybe-disable; no revert of the decided architecture (maintenance WEEKLY-first, split-independent, bootstrap residual, circuit breaker, `/opt/stock-autotrader`, hermes execution, transactional installer).