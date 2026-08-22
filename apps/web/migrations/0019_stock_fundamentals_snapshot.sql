-- Current-only fundamentals read model for the five Stock Detail cards.
-- Provider collection stays on the VPS; the Worker only serves this table.
CREATE TABLE IF NOT EXISTS stock_fundamentals_snapshot (
  symbol TEXT PRIMARY KEY,
  market_cap REAL,
  pe_ttm REAL,
  revenue_ttm REAL,
  operating_income_ttm REAL,
  pretax_income_ttm REAL,
  income_tax_ttm REAL,
  operating_cash_flow_ttm REAL,
  capex_ttm REAL,
  free_cash_flow_ttm REAL,
  cash REAL,
  short_term_investments REAL,
  total_debt REAL,
  shareholders_equity REAL,
  roic_pct REAL,
  fcf_margin_pct REAL,
  debt_to_equity REAL,
  accounting_as_of TEXT,
  market_as_of TEXT,
  accounting_source TEXT NOT NULL,
  market_source TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stock_fundamentals_updated
  ON stock_fundamentals_snapshot (updated_at DESC);
