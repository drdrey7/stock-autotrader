-- 0014_latest_quotes.sql — Screener PR1: provider-neutral latest quote state.
--
-- One row per Core Universe symbol, UPSERTed on every refresh (never appended),
-- so intraday collection cannot grow the table. No historical intraday rows,
-- no minute/hour candles — those belong to later PRs.
--
-- Deliberately NO extra indexes beyond the PRIMARY KEY: D1 free-tier index
-- writes count toward usage, and the only access patterns are keyed upserts
-- (symbol) and a full read of the 50-row table, both served by the PK.
CREATE TABLE IF NOT EXISTS latest_quotes (
  symbol TEXT PRIMARY KEY,
  price REAL NOT NULL CHECK (price > 0),
  change_abs REAL NOT NULL,
  change_pct REAL NOT NULL,
  day_high REAL,
  day_low REAL,
  day_open REAL,
  previous_close REAL,
  provider TEXT NOT NULL,
  provider_timestamp TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
