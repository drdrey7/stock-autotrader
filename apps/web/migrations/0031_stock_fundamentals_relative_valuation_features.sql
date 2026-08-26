-- Relative valuation facts: P/S and P/B trailing 5-year statistics plus the
-- compact revenue-per-share and book-value-per-share points, all derived from
-- the same Finnhub metric=all response already fetched by the fundamentals
-- ingestor. Data/pipeline layer only (no Worker/UI read yet; Automatic IV is
-- PR2). P/S and P/B are stored as normal multiples; *_samples is 0 and
-- *_as_of NULL when the trailing 5-year window has no valid points.
ALTER TABLE stock_fundamentals_snapshot ADD COLUMN revenue_per_share_ttm REAL;
ALTER TABLE stock_fundamentals_snapshot ADD COLUMN book_value_per_share REAL;
ALTER TABLE stock_fundamentals_snapshot ADD COLUMN ps_5y_p25 REAL;
ALTER TABLE stock_fundamentals_snapshot ADD COLUMN ps_5y_median REAL;
ALTER TABLE stock_fundamentals_snapshot ADD COLUMN ps_5y_p75 REAL;
ALTER TABLE stock_fundamentals_snapshot ADD COLUMN ps_5y_samples INTEGER;
ALTER TABLE stock_fundamentals_snapshot ADD COLUMN ps_5y_as_of TEXT;
ALTER TABLE stock_fundamentals_snapshot ADD COLUMN pb_5y_p25 REAL;
ALTER TABLE stock_fundamentals_snapshot ADD COLUMN pb_5y_median REAL;
ALTER TABLE stock_fundamentals_snapshot ADD COLUMN pb_5y_p75 REAL;
ALTER TABLE stock_fundamentals_snapshot ADD COLUMN pb_5y_samples INTEGER;
ALTER TABLE stock_fundamentals_snapshot ADD COLUMN pb_5y_as_of TEXT;