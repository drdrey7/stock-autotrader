# HISTORY SMA RELIABILITY — plan (2026-08-24)

Branch: `fix/history-sma-reliability` (base origin/main 5ffa953).
Goal: keep 200W SMA **always visible** once it exists; last-known-good; maintenance WEEKLY-priority over bootstrap; splits decoupled; minimal provider requests.

## Root cause (confirmed in code)
1. **Worker** `apps/web/worker/sma/metrics.ts` line 93-103: `delta = quoteWeek - anchorWeek`; when `delta > 1` (anchor 1+ week stale) returns `Unavailable`. Today 36 symbols sit at `anchor_week=2026-08-14`; quote week W35 → delta 2 → `Unavailable` → `—` in UI.
2. **maintenance.py** `run()` runs WEEKLY block only when `phase()=="weekly"`, i.e. ONLY after ALL symbols' splits are `done`. SPLITS phase costs ~50 provider requests. Bootstrap (06:00) exhausts the 50/day before maintenance (07:00) → SPLITS never completes → WEEKLY never runs → anchor never rolls forward.

## Existing pieces that already help
- `apply-due-splits` = daily ZERO-provider split application (reading stored `split_events`). Already separate + correct.
- `technical_metrics` keeps `closed_sma_200w`, `sum_199`, `anchor_close`, `status` per symbol; D1 is additive.
- `provider.py` circuit breaker / pacing / quota already sound.

## Changes

### A. Worker last-known-good — `apps/web/worker/sma/metrics.ts`
When `delta > 1` (anchor stale because weekly refresh lagged), if a previously-valid closed SMA exists, serve it instead of `Unavailable`:
- If `metrics.closed_sma_200w != null` → serve `closed_sma_200w` as `sma200w`, compute distance `(price/sma - 1)*100`, classify Above/Near/Below. HistoryWeeks/AsOf carried.
- Else → fall to `NotEnoughHistory` (never had valid basis) — honest.
Do NOT null out a valid value purely because the latest week isn't stored.
`delta < 0` (quote older than basis) stays `Unavailable` (inconsistent data).

Update `metrics.test.ts`: replace/rework the "Unavailable on maintenance data gap (delta 2)" test to assert last-known-good; add tests for delta>0 with valid closed_sma, and delta>1 with no closed_sma → NotEnoughHistory.

### B. Decouple SPLITS from maintenance — `maintenance.py` + `maintenance_state.py`
- `maintenance.run()` drops the SPLITS phase entirely. It becomes **WEEKLY-priority**: for each symbol fetch TIME_SERIES_WEEKLY → adjust from stored `split_events` (D1, no provider) → upsert changed rows → recompute metrics. Never blocked by splits status.
- `phase()` in `maintenance_state.py`: drop the "splits" gating. Cycle = { weekly, metrics } only. `phase()` returns "weekly" while any weekly/metrics pending, else "complete".
- Keep `apply_due_splits` as the separate zero-provider daily split application (already correct, no duplication).
- Provide a dedicated low-frequency **provider SPLITS reconciliation** path separate from weekly (see D) so new splits are still discovered without blocking WEEKLY.

### C. Bootstrap residual budget — bootstrap.py + cli.py + service
- Bootstrap keeps honest 47/50 checkpoint. Add a **daily request cap** so one problem symbol (PLTR/QCOM/RDDT) can never exhaust quota.
- `--limit` already exists on bootstrap CLI. Add config `bootstrap_max_requests_per_day` (default 6); bootstrap.run() applies it when limit is None. systemd unit may rely on default.
- Keep `maybe-disable` exactly as-is (only disables at 50/50; NOT weakened to >=45). PLTR/QCOM/RDDT stay pending honestly.

### D. Low-frequency SPLITS reconciliation — NEW `reconcile-splits` command
- New CLI subcommand `reconcile-splits`: fetches provider SPLITS per symbol (bounded, quota-aware, after maintenance), compares vs durable split_events; on change rewrites that symbol's history + metrics. Runs on low cadence (weekly), NOT daily.
- Reuses the existing `_reconcile_splits` logic from maintenance — moved/adapted into a dedicated runner method. No overlap with `apply-due-splits` (that stays zero-provider daily).
- Default cadence: **weekly Sunday 08:30 UTC** (keeps freshness, but separated from Monday WEEKLY).

### E. systemd cadence (all UTC, no overlap)
- **maintenance.timer**: `Mon *-*-* 07:00 UTC` (WEEKLY refresh on the just-closed week). RandomizedDelay small. Persistent.
- **bootstrap.timer**: `*-*-* 08:00 UTC` daily, residual, AFTER maintenance. Persistent. (Bootstrap still auto-disables at 50/50.)
- **due-split.timer**: `Tue..Sat 13:10 UTC` — unchanged (zero-provider daily).
- **reconcile-split.timer** (new): `Sun *-*-* 08:30 UTC` weekly (SPLITS provider check, separated from Monday WEEKLY).
- Ordering: maintenance `After=network-online`; bootstrap `After=maintenance`; reconcile-split independent; due-split last.
- No two provider-fetching timers in the same UTC slot → maintenance never starves.

### F. Installer — add the new reconcile-split unit
- `install-history-ingestor-root.sh`: add `history-ingestor-reconcile-split.{service,timer}` to UNITS/SERVICES/TIMERS arrays. Transactional behavior unchanged. Verify staged unit via systemd-analyze.

### G. Tests (mock provider, real Az Vantage only on dry-run/CI-disabled)
Python (`apps/history-ingestor/tests`):
- `test_sma.py`/`test_maintenance.py`: maintenance weekly runs and updates weekly_prices + metrics WITHOUT any splits provider call; not blocked when splits status pending.
- `test_maintenance.py`: previously-valid SMA preserved in D1 when a WEEKLY fetch fails (row/metrics not nulled).
- bootstrap: residual request budget enforced (limit consumed; problem symbol cannot exhaust).
- reconcile-splits: changed split rewrites only that symbol; duplicate split checks removed.
- existing circuit-breaker/quota/pacing tests unchanged (no regression).
- no real Alpha Vantage calls in tests (FakeProvider).

Frontend/TS:
- `metrics.test.ts` (above), plus stock-detail/read-model test asserting a previously-valid SMA stays exposed when anchor stale.
- `ScreenerTable.smaCell` stays: shows value when `sma200w` non-null; `NotEnoughHistory` tooltip; no new stale badge. (Only behavioral change already covered by Worker.)

### H. Validation sequence
1. `python3 -m unittest discover -s apps/history-ingestor/tests -v`
2. `ruff check apps/history-ingestor`
3. `npm run lint` + `npm run typecheck` + `npm test` + `npm run build` (apps/web)
4. `systemd-analyze verify deploy/*.service deploy/*.timer`
5. `npx wrangler d1 execute --remote` smoke (read-only) after PR — verify SMA serves for stale symbols (operational, post-merge).
6. Full diff review before commit.

## Out of scope (explicit)
- No manual prod D1 edits; no real provider calls during dev; no quota/plan/keys changes; no fundamentals/X Pulse; no frontend redesign beyond last-known-good/N/A; no weakening of maybe-disable.