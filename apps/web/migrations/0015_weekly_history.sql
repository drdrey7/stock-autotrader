-- 0015_weekly_history.sql — Screener PR2: historical weekly prices + SMA basis.
--
-- weekly_prices     raw/as-traded Alpha Vantage TIME_SERIES_WEEKLY buckets,
--                   split-ONLY adjusted (never dividend-adjusted), one row per
--                   (symbol, week_end_date), UPSERTed idempotently by the
--                   history ingestor. week_end_date is the provider's bucket
--                   date = the week's last trading day (a Thursday when the
--                   Friday is a holiday). ~50 symbols x ~20y ~ 1k rows each.
--                   split_adjustment_factor is the cumulative divisor F(t):
--                   split_adjusted_close = raw_close / F(t), where F(t) is the
--                   product of all split ratios effective strictly after the
--                   observation's week end. Both raw close and factor are
--                   persisted so every row is auditable/recomputable.
--                   In-progress (current) weeks are NEVER stored — the
--                   ingestor drops the bucket whose ISO week matches the
--                   fetch-time NY ISO week, so the historical basis is
--                   deterministic regardless of when bootstrap runs.
--
-- technical_metrics precomputed rolling basis for the LIVE 200-week SMA:
--                   sum_199 = sum of the 199 most recent completed
--                   split-adjusted closes ending at anchor_week (the latest
--                   completed stored week L); anchor_close = the split-
--                   adjusted close of week L (one-row correction the Worker
--                   uses when the live quote's own week is already stored);
--                   closed_sma_200w = plain 200-week SMA over completed weeks
--                   (informational). The Worker combines this basis with
--                   latest_quotes.price at read time — no 200x50 row reads
--                   per Screener request. Recalculated weekly (or on split
--                   reconciliation), never per WebSocket tick.
--
-- Deliberately NO extra indexes beyond the PRIMARY KEYs: the only access
-- patterns are per-symbol range scans (PK (symbol, week_end_date) covers
-- them) and the 50-row technical_metrics table — D1 free-tier index writes
-- count toward usage, and this scale is tiny (50 x ~1k rows).

CREATE TABLE IF NOT EXISTS weekly_prices (
  symbol TEXT NOT NULL,
  week_end_date TEXT NOT NULL,
  raw_open REAL NOT NULL,
  raw_high REAL NOT NULL,
  raw_low REAL NOT NULL,
  raw_close REAL NOT NULL CHECK (raw_close > 0),
  volume INTEGER NOT NULL CHECK (volume >= 0),
  split_adjustment_factor REAL NOT NULL CHECK (split_adjustment_factor > 0),
  split_adjusted_close REAL NOT NULL CHECK (split_adjusted_close > 0),
  source TEXT NOT NULL DEFAULT 'alpha-vantage',
  source_fetched_at TEXT NOT NULL,
  PRIMARY KEY (symbol, week_end_date)
);

CREATE TABLE IF NOT EXISTS technical_metrics (
  symbol TEXT PRIMARY KEY,
  anchor_week TEXT,
  completed_weeks_available INTEGER NOT NULL CHECK (completed_weeks_available >= 0),
  sum_199 REAL,
  anchor_close REAL,
  closed_sma_200w REAL,
  historical_data_as_of TEXT,
  calculated_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'limited', 'not_enough_history', 'no_data')),
  source TEXT NOT NULL DEFAULT 'alpha-vantage'
);
