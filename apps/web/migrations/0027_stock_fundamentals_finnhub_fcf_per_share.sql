-- Direct Finnhub TTM FCF/share is the only extra input needed by the future
-- simple per-share DCF. Existing Stock Detail card columns are reused.
ALTER TABLE stock_fundamentals_snapshot
  ADD COLUMN fcf_per_share_ttm REAL;
