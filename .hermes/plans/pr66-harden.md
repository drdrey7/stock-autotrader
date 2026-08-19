# PR66 Harden — plan (2026-08-19)

Scope frozen (PR2). No new features. Files to change:

## Frontend / Worker (apps/web)
1. `worker/sma/metrics.ts` — delta=0 math: replace `sum_199 - anchor_close` basis
   with `prior_199_sum = closed_sma_200w * 200 - anchor_close`; NotEnoughHistory
   when no true 200-week basis. Update metrics.test.ts (uniform fixture now wrong).
2. `src/morning-briefing/screener/screener-compat.ts` (new) — normalize old
   production payload rows (missing SMA fields -> null/Unavailable). Wire into
   useScreener. Defensive render in ScreenerTable. Tests: pre-PR2 payload renders
   "--", no crash.

## History ingestor (apps/history-ingestor)
3. `apps/web/migrations/0016_split_events.sql` (new) — additive split_events table.
4. `d1.py` — upsert/read split_events (batched, idempotent), read_all for audit.
5. `parser.py` — SPLITS hardening: missing `data`/`splits` key -> PayloadError
   (data:[] alone = verified empty); non-object payload -> PayloadError.
6. `provider.py` — JSONDecodeError + non-dict payload -> ProviderError.
7. `splits.py` — row <-> SplitEvent helpers (exact Fraction round-trip).
8. `bootstrap.py` — persist split_events durably on fetch; on resume load from D1
   (never a duplicate SPLITS request); legacy empty-store backfill once + factor
   consistency guard.
9. `maintenance_state.py` (new) — durable cycle checkpoint (app_meta
   historyMaintenanceState): cycle target week, phase, per-symbol
   splits/weekly/metrics status. Separate from bootstrap state.
10. `maintenance.py` — rewrite: cycle-based, Sunday SPLITS reconcile (compare vs
    stored split_events; on change replace + full historical rewrite + metrics),
    Monday WEEKLY (fetch, drop in-progress, adjust from stored split_events,
    upsert only changed rows incl. raw OHLCV, recompute metrics). Durable resume;
    zero provider calls when cycle complete; quota-preserving.
11. `weeks.py` — target_completed_week(now) = ISO week of most recent Friday.
12. `cli.py` — quota = exit 0 (expected), real failure = non-zero. status shows
    maintenance cycle.
13. `deploy/history-ingestor-maintenance.timer` — Sun + Mon entries.
    `history-ingestor-maintenance.service` — comments/semantics. verify unit.
14. README — architecture notes.

## Validation
- Independent SMA check (plain math over D1 raw + split_events) for NVDA/AAPL/...
- systemd-analyze verify; migration local + additive safety; secret scan.
- Full suite: python unittest + ruff; TS lint/typecheck/test/coverage/build;
  playwright; wrangler dry-runs; git diff --check.
- Continue bootstrap from checkpoint using quota; prioritize TSLA MSFT NVO ASML.
- Cloudflare preview desktop+mobile /screener verification after push.
- OpenCode actual comment verification.
