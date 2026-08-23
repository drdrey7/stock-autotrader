ALTER TABLE stock_fundamentals_snapshot
  ADD COLUMN accounting_refresh_status TEXT NOT NULL DEFAULT 'unknown';
