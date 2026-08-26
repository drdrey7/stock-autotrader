-- Relative valuation facts: P/S and P/B trailing 5-year statistics plus the
-- compact revenue-per-share and book-value-per-share points, all derived from
-- the same Finnhub metric=all response already fetched by the fundamentals
-- ingestor. Data/pipeline layer only (no Worker/UI read yet; Automatic IV is
-- PR2). P/S and P/B are stored as normal multiples.
-- *_as_of semantics (matches PR #118): if a parseable reported period exists,
-- as_of holds that latest period while the percentiles may still be NULL when
-- the 5-year window has no positive points (samples = 0). as_of is NULL only
-- when no parseable period exists at all.
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
