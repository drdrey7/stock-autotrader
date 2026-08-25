# HISTORY SMA RELIABILITY — plan (2026-08-24)

Branch: `fix/history-sma-reliability`.

Goal: keep 200W SMA **always visible** once it exists; last-known-good;
maintenance WEEKLY-priority over bootstrap; splits decoupled; minimal provider
requests.

## Root cause (confirmed in code)

1. **Worker** `apps/web/worker/sma/metrics.ts`: when `delta > 1` (anchor 1+ week stale) it returned `Unavailable`, causing valid stored SMA values to render as `—`.
2. **maintenance.py** previously gated WEEKLY behind a provider SPLITS phase. SPLITS could consume the shared Alpha Vantage daily entitlement before WEEKLY refreshed the 200W basis.

## Existing pieces that already help

- `apply-due-splits` = ZERO-provider split application (reading stored `split_events`).
- `technical_metrics` keeps `closed_sma_200w`, `sum_199`, `anchor_close`, `status` per symbol; D1 is durable.
- `provider.py` circuit breaker / pacing / shared per-key quota ledger.

## Changes

### A. Worker last-known-good — `apps/web/worker/sma/metrics.ts`

When `delta > 1` (anchor stale because weekly refresh lagged), if a previously-valid closed SMA exists, serve it instead of `Unavailable`:

- If `metrics.closed_sma_200w != null` -> serve `closed_sma_200w` as `sma200w`, compute distance `(price/sma - 1)*100`, classify Above/Near/Below. HistoryWeeks/AsOf carried.
- Else -> fall to `NotEnoughHistory` (never had valid basis).
- **Split-scale mismatch is checked BEFORE the delta>1 branch** and always stays `Unavailable`; last-known-good never overrides it.
- `delta < 0` (quote older than basis) stays `Unavailable`.

The frontend therefore depends on durable D1 data, not VPS uptime. If the VPS is temporarily offline, the most recent valid SMA remains visible.

### B. Weekly-first maintenance

- `maintenance.run()` does not fetch provider SPLITS. It is **WEEKLY-priority**: fetch `TIME_SERIES_WEEKLY` -> adjust from stored `split_events` -> upsert changed rows -> recompute metrics.
- Monday normally performs one refresh per Core Universe symbol (~50 requests total).
- The timer still runs Tue-Sat only as automatic catch-up. Once the weekly cycle is complete, subsequent runs perform ZERO provider calls.
- `phase()` treats weekly `error` as unfinished weekly work, so it retries in the current cycle.
- `apply_due_splits` remains a separate zero-provider operation.

### C. Bootstrap — one-shot and self-disabling

- Bootstrap is initial historical loading only. It is not permanent maintenance.
- `bootstrap_max_requests_per_day` defaults to 6 and is a hard per-UTC-day residual cap while bootstrap remains incomplete.
- Exact HTTP debits are persisted at the provider ledger boundary, including `Information` / `Note` attempts and internal multi-key retries.
- Restarting the process/systemd service cannot reset the same-day budget.
- `--limit` can only lower the configured cap.
- The auto-disable gate remains exact: `bootstrap_done=50`, `bootstrap_pending=0`, `universe_total=50`.

Important semantic: **50/50 means both bootstrap provider endpoints completed for all 50 symbols. It does NOT mean 50 symbols have a numeric 200W SMA.** A recently-listed company with fewer than 200 completed weeks can correctly finish bootstrap and have `technical_metrics.status=not_enough_history`. That symbol shows `N/A` and must not keep bootstrap alive forever.

Therefore, once production status is 50/50 terminal, the bootstrap timer should disable itself and stay disabled.

### D. Low-frequency SPLITS reconciliation

Splits are rare compared with weekly price updates, so daily provider polling is unnecessary.

- Provider SPLITS discovery is decoupled from weekly SMA maintenance.
- `reconcile-splits` runs on the **first and third Tuesday of each month at 09:00 UTC** (roughly fortnightly).
- Each invocation is explicitly capped at 50 HTTP requests, one per Core Universe symbol in the normal case.
- The shared provider ledger is still the true ceiling: if Tuesday maintenance or residual bootstrap used quota first, reconciliation consumes only what is left and saves its durable cursor.
- `Persistent=false` prevents a missed scan from racing maintenance after downtime.
- Progress uses independent `historyReconcileSplitState`; weekly rollover and filtered manual runs cannot erase unrelated progress.
- `--dry-run` remains provider-free.
- Changed splits rewrite only the affected symbol's stored history/metrics.

Tuesday is deliberate: Monday may legitimately use the entire 50-request entitlement for the weekly history refresh. Tuesday maintenance gets first chance to finish any carryover before split discovery uses residual quota.

### E. systemd cadence and quota

Alpha Vantage entitlement used by this app is **25 requests/day per key**. With two configured keys the nominal aggregate is **50 requests/day total**.

- **maintenance.timer**: daily 07:00 UTC; real provider work is effectively weekly, with Tue-Sat catch-up only.
- **bootstrap.timer**: daily 08:00 UTC only while bootstrap is incomplete; exact HTTP hard cap 6/day; auto-disables at terminal 50/50 endpoint completion.
- **reconcile-split.timer**: first + third Tuesday 09:00 UTC; `Persistent=false`; explicit cap 50/run, still constrained by shared daily provider ledger.
- **due-split.timer**: Tue-Sat 13:10 UTC; zero-provider.

Priority is always:

`maintenance > temporary bootstrap > split reconciliation > zero-provider due-split`.

### F. Installer / fresh install

- `install-history-ingestor-root.sh` includes reconcile-split service/timer transactionally.
- Fresh install enables the recurring timers that are required; bootstrap is only needed until initial historical loading reaches terminal 50/50 endpoint completion.

## Tests (mock provider, no real calls)

Python (`apps/history-ingestor/tests`):

- maintenance WEEKLY runs without provider SPLITS calls;
- previously-valid SMA is preserved when a WEEKLY fetch fails;
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

## Out of scope

- No manual production D1 edits.
- No real provider calls during development/tests.
- No quota/plan/key changes.
- No frontend redesign beyond last-known-good / N/A behavior.
- No weakening of terminal 50/50 bootstrap endpoint completion semantics.
