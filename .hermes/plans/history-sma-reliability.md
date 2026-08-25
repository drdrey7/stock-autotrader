# HISTORY SMA RELIABILITY — plan (2026-08-24)

Branch: `fix/history-sma-reliability`.

Goal: keep 200W SMA **always visible** once it exists; last-known-good;
maintenance WEEKLY-priority over bootstrap; splits decoupled; minimal provider
requests.

## Root cause (confirmed in code)

1. **Worker** `apps/web/worker/sma/metrics.ts`: when `delta > 1` (anchor 1+ week stale) it returned `Unavailable`, causing valid stored SMA values to render as `—`.
2. **maintenance.py** previously gated WEEKLY behind a provider SPLITS phase. SPLITS could consume the shared Alpha Vantage daily entitlement before WEEKLY refreshed the 200W basis.

## Existing pieces that already help

- `apply-due-splits` = daily ZERO-provider split application (reading stored `split_events`).
- `technical_metrics` keeps `closed_sma_200w`, `sum_199`, `anchor_close`, `status` per symbol; D1 is additive.
- `provider.py` circuit breaker / pacing / shared per-key quota ledger.

## Changes

### A. Worker last-known-good — `apps/web/worker/sma/metrics.ts`

When `delta > 1` (anchor stale because weekly refresh lagged), if a previously-valid closed SMA exists, serve it instead of `Unavailable`:

- If `metrics.closed_sma_200w != null` -> serve `closed_sma_200w` as `sma200w`, compute distance `(price/sma - 1)*100`, classify Above/Near/Below. HistoryWeeks/AsOf carried.
- Else -> fall to `NotEnoughHistory` (never had valid basis).
- **Split-scale mismatch is checked BEFORE the delta>1 branch** and always stays `Unavailable`; last-known-good never overrides it.
- `delta < 0` (quote older than basis) stays `Unavailable`.

### B. Decouple SPLITS from maintenance — `maintenance.py` + `maintenance_state.py`

- `maintenance.run()` drops the provider SPLITS phase entirely. It becomes **WEEKLY-priority**: fetch TIME_SERIES_WEEKLY -> adjust from stored `split_events` -> upsert changed rows -> recompute metrics.
- `phase()` treats weekly `error` as unfinished weekly work, so it retries in the current cycle.
- `apply_due_splits` remains the separate zero-provider daily split application.
- Provider SPLITS discovery moves to dedicated `reconcile-splits` state/cadence.

### C. Bootstrap residual budget — exact HTTP accounting

- Bootstrap keeps its honest incomplete checkpoint until all 50 symbols are complete.
- `bootstrap_max_requests_per_day` defaults to 6 and is a HARD per-UTC-day cap.
- The exact cap is enforced at the provider ledger boundary through `BootstrapBudgetLedger`, not after a logical `fetch_*` returns.
- Every real provider HTTP debit is persisted immediately, including `Information` / `Note` attempts and multi-key retries inside one logical fetch.
- A process/systemd restart on the same UTC day inherits the already-spent exact HTTP count.
- `--limit` is an additional per-invocation cap and can only lower the daily cap.
- The previous logical bootstrap counter remains only for backwards compatibility/reporting; it is not the safety boundary.

Tests cover internal multi-key retry with cap=1 and same-day new-ledger/restart semantics.

### D. Low-frequency SPLITS reconciliation — `reconcile-splits`

- Fetches provider SPLITS per symbol, bounded and quota-aware.
- `--dry-run` is provider-free.
- Progress uses independent `historyReconcileSplitState`; maintenance weekly rollover cannot erase it.
- Capped runs resume unfinished symbols.
- A filtered manual run (`--symbols ...`) is only a processing filter: starting a new filtered pass resets those requested symbols without replacing/erasing persistent progress for unrelated universe members.
- Changed splits rewrite only the affected symbol's stored history/metrics.
- Default cadence: weekly **Tuesday 09:00 UTC**, `Persistent=false`.

### E. systemd cadence and real quota

Alpha Vantage entitlement used by this app is **25 requests/day per key**. With two configured keys the aggregate nominal budget is **50 requests/day total**, not 100.

- **maintenance.timer**: `*-*-* 07:00 UTC` daily; Monday normally refreshes the 50 WEEKLY series and may consume essentially the entire 50-request day.
- **bootstrap.timer**: `*-*-* 08:00 UTC` daily, residual, after maintenance, exact HTTP hard cap default 6/day.
- **reconcile-split.timer**: `Tue *-*-* 09:00 UTC`, `Persistent=false`, explicit cap 20/run.
- **due-split.timer**: `Tue..Sat 13:10 UTC`, zero-provider.

Why Tuesday for reconciliation: Monday is reserved for the primary 200W WEEKLY refresh. On a healthy cycle Tuesday maintenance is a zero-provider noop; if Monday was incomplete, Tuesday maintenance still gets first priority before bootstrap/reconciliation can consume residual quota.

`Persistent=false` on reconciliation prevents a missed split scan from catch-up racing a due maintenance run after downtime.

### F. Installer / fresh install

- `install-history-ingestor-root.sh` includes reconcile-split service/timer transactionally.
- Fresh install enables all four timers: maintenance, bootstrap, reconcile-split, due-split.

## Tests (mock provider, no real calls)

Python (`apps/history-ingestor/tests`):

- maintenance WEEKLY runs without provider SPLITS calls;
- previously-valid SMA is preserved when a WEEKLY refresh fails;
- bootstrap cap is enforced on actual HTTP debits, including internal key retry;
- exact bootstrap daily usage survives a new process/ledger on the same UTC day;
- reconcile-splits dry-run is zero-provider;
- reconcile progress survives weekly rollover and filtered pass reset preserves unrelated symbols;
- changed split rewrites only that symbol and reports metrics update;
- empty split-events scenario runs weekly cleanly.

Frontend/TS:

- last-known-good delta>1;
- NotEnoughHistory distinct;
- split-scale mismatch with delta>1 stays Unavailable;
- Stock Detail keeps previously-valid SMA exposed when anchor is stale.

## Validation sequence

```bash
# Python tests + lint
cd apps/history-ingestor && python3 -m unittest discover -s tests -v
cd <repo root> && ruff check apps/history-ingestor

# Web tests / lint / typecheck / build
cd apps/web && npm run lint && npm run typecheck && npm test && npm run build

# systemd-analyze verify
systemd-analyze verify apps/history-ingestor/deploy/*.service apps/history-ingestor/deploy/*.timer

# bash -n installer
bash -n apps/history-ingestor/deploy/install-history-ingestor-root.sh

# Post-merge read-only D1 smoke
cd apps/web && npx wrangler d1 execute stock-autotrader-db --remote --command="SELECT symbol, anchor_week, historical_data_as_of, closed_sma_200w, status FROM technical_metrics WHERE closed_sma_200w IS NOT NULL ORDER BY historical_data_as_of ASC LIMIT 20;"
```

## Out of scope (explicit)

- No manual production D1 edits.
- No real provider calls during development/tests.
- No quota/plan/key changes.
- No frontend redesign beyond last-known-good / N/A behavior.
- No weakening of exact 50/50 bootstrap completion semantics.
