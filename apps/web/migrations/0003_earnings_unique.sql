-- 0003_earnings_unique.sql — fix EARNINGS upsert (PR #3 review)
-- Dedupe existing rows (keep newest per symbol+date), then enforce uniqueness
-- so ON CONFLICT (symbol, date) in the ingest path actually fires.

DELETE FROM earnings
WHERE id NOT IN (
  SELECT MAX(id) FROM earnings GROUP BY symbol, date
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_earnings_symbol_date ON earnings(symbol, date);
