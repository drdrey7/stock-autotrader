ALTER TABLE stock_fundamentals_snapshot ADD COLUMN net_income_ttm REAL;
ALTER TABLE stock_fundamentals_snapshot ADD COLUMN diluted_eps_ttm REAL;
ALTER TABLE stock_fundamentals_snapshot ADD COLUMN depreciation_amortization_ttm REAL;
ALTER TABLE stock_fundamentals_snapshot ADD COLUMN shares_outstanding REAL;

-- Force one post-migration accounting pass so existing rows receive the new
-- inputs. A successful pass records `ok` again, including legitimate partials.
UPDATE stock_fundamentals_snapshot
SET accounting_refresh_status = 'incomplete'
WHERE accounting_refresh_status = 'ok';

CREATE TABLE IF NOT EXISTS stock_fundamentals_annual (
  symbol TEXT NOT NULL,
  fiscal_year INTEGER NOT NULL,
  revenue REAL,
  operating_income REAL,
  pretax_income REAL,
  income_tax REAL,
  net_income REAL,
  diluted_eps REAL,
  operating_cash_flow REAL,
  capex REAL,
  free_cash_flow REAL,
  depreciation_amortization REAL,
  cash REAL,
  total_debt REAL,
  shareholders_equity REAL,
  shares_outstanding REAL,
  as_of TEXT,
  source TEXT NOT NULL,
  PRIMARY KEY (symbol, fiscal_year)
);
