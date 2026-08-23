-- Keep the current snapshot as provider/input data. The serving Worker derives
-- the three accounting cards from these inputs; the legacy nullable columns
-- remain only for backwards-compatible reads.
ALTER TABLE stock_fundamentals_snapshot ADD COLUMN beta REAL;
ALTER TABLE stock_fundamentals_snapshot ADD COLUMN eps_ttm REAL;
ALTER TABLE stock_fundamentals_snapshot ADD COLUMN dividend_yield REAL;
ALTER TABLE stock_fundamentals_snapshot ADD COLUMN market_checked_at TEXT;
ALTER TABLE stock_fundamentals_snapshot ADD COLUMN accounting_filing_form TEXT;
ALTER TABLE stock_fundamentals_snapshot ADD COLUMN current_assets REAL;
ALTER TABLE stock_fundamentals_snapshot ADD COLUMN current_liabilities REAL;

ALTER TABLE stock_fundamentals_annual ADD COLUMN current_assets REAL;
ALTER TABLE stock_fundamentals_annual ADD COLUMN current_liabilities REAL;

-- These values were derived by the old card pipeline and have no place in the
-- ingestion snapshot. Keep the columns only for backwards-compatible reads.
UPDATE stock_fundamentals_snapshot
SET roic_pct = NULL,
    fcf_margin_pct = NULL,
    debt_to_equity = NULL,
    market_as_of = NULL;
