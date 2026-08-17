-- 0011_earnings_company_metadata.sql — Finnhub Company Profile 2 enrichment
--
-- Enrich the existing Earnings universe with stable company metadata
-- (logo URL, industry, website). Only external URLs are stored; image
-- binary data never enters D1. The Finnhub API key stays server-side.
--
-- Additive migration: no existing column is dropped or rewritten.
PRAGMA foreign_keys = ON;

ALTER TABLE earnings_universe ADD COLUMN logo_url TEXT;
ALTER TABLE earnings_universe ADD COLUMN industry TEXT;
ALTER TABLE earnings_universe ADD COLUMN website_url TEXT;

-- Dedicated freshness stamp for Finnhub profile enrichment. The shared
-- updated_at column is also owned by Core reconciliation and SEC metadata
-- syncs, so it cannot express profile staleness on its own.
ALTER TABLE earnings_universe ADD COLUMN metadata_updated_at TEXT;