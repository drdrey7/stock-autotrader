-- 0016_split_events.sql — Screener PR2 hardening: durable split history.
--
-- One row per (symbol, effective_date) split event fetched from Alpha Vantage
-- SPLITS. split_factor is the provider's ratio as a REAL (> 0; 4.0 = 4:1,
-- 0.5 = 1:2 reverse split) — the same REAL persistence used by
-- weekly_prices.split_adjustment_factor, so both stay consistent and
-- auditable.
--
-- Why a durable table (additive, non-destructive):
--   * bootstrap resume must NOT refetch split history that is already
--     completed — split data can no longer live only in RAM between runs;
--   * the weekly SPLITS pass compares the provider's current history with
--     the stored events; a changed/new split deterministically triggers a
--     historical recalculation;
--   * split history is auditable and comparable over time.
--
-- Storage is an idempotent UPSERT keyed by (symbol, effective_date); no
-- duplicate Core Universe — the table holds events only for symbols the
-- ingestor processes (the canonical universe drives the loop).
--
-- Deliberately no extra indexes beyond the PRIMARY KEY: access patterns are
-- the per-symbol read (PK covers it) and the full scan in the maintenance
-- comparison (tiny: <= 50 symbols x a handful of events each).

CREATE TABLE IF NOT EXISTS split_events (
  symbol TEXT NOT NULL,
  effective_date TEXT NOT NULL,
  split_factor REAL NOT NULL CHECK (split_factor > 0),
  source TEXT NOT NULL DEFAULT 'alpha-vantage',
  source_fetched_at TEXT NOT NULL,
  PRIMARY KEY (symbol, effective_date)
);
