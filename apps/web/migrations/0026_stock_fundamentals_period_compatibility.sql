-- ROIC must not combine TTM income with a balance sheet from another period.
ALTER TABLE stock_fundamentals_snapshot
  ADD COLUMN accounting_periods_compatible INTEGER NOT NULL DEFAULT 0;
