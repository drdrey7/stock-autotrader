-- 0013_earnings_official_metrics.sql — official (SEC GAAP) vs provider (Finnhub) metrics
--
-- Establishes an official-first data model for the latest reported quarter of each
-- active Core Universe company without collapsing accounting bases:
--
--   SEC GAAP actuals (sec-xbrl / sec-filing)   -> eps_actual_gaap / revenue_actual_official
--   Finnhub calendar actuals (adjusted basis)  -> eps_actual_adjusted / legacy eps_actual
--   Finnhub consensus estimates                -> legacy eps_estimate + provenance columns
--
-- Additive only: no column is dropped, renamed, or reinterpreted. Existing legacy
-- eps_actual / revenue_actual keep their provider semantics (Finnhub adjusted/non-GAAP
-- actuals) for backward compatibility with the UI/API; the new authoritative fields are
-- additive and nullable. Null means "not resolved yet / not audited", never zero.
--
-- Source values are explicit strings:
--   sec-xbrl, sec-filing, finnhub-consensus, finnhub-adjusted
PRAGMA foreign_keys = ON;

ALTER TABLE earnings_events ADD COLUMN eps_actual_gaap REAL;
ALTER TABLE earnings_events ADD COLUMN eps_actual_gaap_source TEXT;

ALTER TABLE earnings_events ADD COLUMN eps_actual_adjusted REAL;
ALTER TABLE earnings_events ADD COLUMN eps_actual_adjusted_source TEXT;

ALTER TABLE earnings_events ADD COLUMN revenue_actual_official REAL;
ALTER TABLE earnings_events ADD COLUMN revenue_actual_source TEXT;

ALTER TABLE earnings_events ADD COLUMN eps_estimate_source TEXT;
ALTER TABLE earnings_events ADD COLUMN revenue_estimate_source TEXT;

ALTER TABLE earnings_events ADD COLUMN reported_at_source TEXT;

-- Audit/quality status for the latest reported quarter:
--   match | different-basis | conflict | official-only | finnhub-only | unresolved | pending
-- NULL = not audited yet.
ALTER TABLE earnings_events ADD COLUMN data_quality_status TEXT;

-- Diagnostic glance for the one-shot backfill + healthz enrichment block.
CREATE INDEX IF NOT EXISTS idx_earnings_events_official_metrics
  ON earnings_events (data_quality_status, symbol);