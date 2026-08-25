-- Pr1 valuation features: derive compact valuation statistics from the same
-- Finnhub metric=all response and store them on the direct-finnhub snapshot.
-- Data/pipeline layer only (no Worker/UI read yet; Automatic IV is PR2).
-- Growth and ROE fields are stored in percentage points; P/E and P/FCF are
-- stored as normal multiples; *_samples is 0 and *_as_of NULL when the
-- trailing 5-year window has no valid points.
ALTER TABLE stock_fundamentals_snapshot ADD COLUMN revenue_growth_ttm_yoy_pct REAL;
ALTER TABLE stock_fundamentals_snapshot ADD COLUMN revenue_growth_3y_pct REAL;
ALTER TABLE stock_fundamentals_snapshot ADD COLUMN revenue_growth_5y_pct REAL;
ALTER TABLE stock_fundamentals_snapshot ADD COLUMN roe_ttm_pct REAL;
ALTER TABLE stock_fundamentals_snapshot ADD COLUMN pe_5y_p25 REAL;
ALTER TABLE stock_fundamentals_snapshot ADD COLUMN pe_5y_median REAL;
ALTER TABLE stock_fundamentals_snapshot ADD COLUMN pe_5y_p75 REAL;
ALTER TABLE stock_fundamentals_snapshot ADD COLUMN pe_5y_samples INTEGER;
ALTER TABLE stock_fundamentals_snapshot ADD COLUMN pe_5y_as_of TEXT;
ALTER TABLE stock_fundamentals_snapshot ADD COLUMN pfcf_5y_p25 REAL;
ALTER TABLE stock_fundamentals_snapshot ADD COLUMN pfcf_5y_median REAL;
ALTER TABLE stock_fundamentals_snapshot ADD COLUMN pfcf_5y_p75 REAL;
ALTER TABLE stock_fundamentals_snapshot ADD COLUMN pfcf_5y_samples INTEGER;
ALTER TABLE stock_fundamentals_snapshot ADD COLUMN pfcf_5y_as_of TEXT;
