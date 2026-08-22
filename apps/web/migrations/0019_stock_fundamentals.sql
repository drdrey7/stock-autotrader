-- 0019_stock_fundamentals.sql — canonical SEC fundamentals tables.
--
-- Aditive migration: creates two new tables without touching existing ones.
--   - stock_fundamental_periods: one row per symbol/fiscal period, normalized
--   - stock_fundamental_snapshots: one row per symbol, latest TTM/read view
--
-- Both are written by the fundamentals-ingestor (VPS) and read by the Worker
-- (serving-only, no SEC calls on page load).

-- Normalized fiscal periods. Natural key: (symbol, fiscal_year, fiscal_period).
-- A restatement/amendment supersedes the prior filing only when the new
-- filing_date >= existing filing_date (see upsert logic).
CREATE TABLE IF NOT EXISTS stock_fundamental_periods (
  symbol TEXT NOT NULL,
  fiscal_year INTEGER NOT NULL,
  fiscal_period TEXT NOT NULL,
  period_start TEXT,
  period_end TEXT,
  filing_date TEXT,
  form TEXT,
  accession TEXT,
  taxonomy TEXT,
  currency TEXT NOT NULL DEFAULT 'USD',
  revenue REAL,
  gross_profit REAL,
  operating_income REAL,
  pretax_income REAL,
  income_tax REAL,
  net_income REAL,
  diluted_eps REAL,
  operating_cash_flow REAL,
  capex REAL,
  depreciation_amortization REAL,
  free_cash_flow REAL,
  cash REAL,
  short_term_investments REAL,
  total_debt REAL,
  total_assets REAL,
  total_liabilities REAL,
  shareholders_equity REAL,
  current_assets REAL,
  current_liabilities REAL,
  weighted_avg_diluted_shares REAL,
  shares_outstanding REAL,
  source TEXT NOT NULL DEFAULT 'sec-xbrl',
  quality TEXT NOT NULL DEFAULT 'partial',
  provenance_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (symbol, fiscal_year, fiscal_period)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_fund_periods_symbol_updated
  ON stock_fundamental_periods (symbol, updated_at DESC);

-- Latest snapshot per symbol. Natural key: symbol.
-- The Worker reads this table only — never periods.
CREATE TABLE IF NOT EXISTS stock_fundamental_snapshots (
  symbol TEXT PRIMARY KEY,
  latest_period_end TEXT,
  revenue_ttm REAL,
  operating_income_ttm REAL,
  pretax_income_ttm REAL,
  income_tax_ttm REAL,
  net_income_ttm REAL,
  diluted_eps_ttm REAL,
  operating_cash_flow_ttm REAL,
  capex_ttm REAL,
  free_cash_flow_ttm REAL,
  cash REAL,
  short_term_investments REAL,
  total_debt REAL,
  shareholders_equity REAL,
  current_assets REAL,
  current_liabilities REAL,
  shares_outstanding REAL,
  roic_ttm REAL,
  fcf_margin_ttm REAL,
  debt_to_equity REAL,
  coverage_status TEXT NOT NULL DEFAULT 'none',
  blockers_json TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'sec-xbrl',
  updated_at TEXT NOT NULL
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_fund_snapshots_coverage
  ON stock_fundamental_snapshots (coverage_status, updated_at DESC);
