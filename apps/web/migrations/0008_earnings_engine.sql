-- 0008_earnings_engine.sql — Cloudflare-owned automated earnings engine (PR #12)
--
-- The legacy `earnings` table remains owned by the quant/screening pipeline.
-- Nothing in this migration changes or deletes that table.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS earnings_universe (
  symbol TEXT PRIMARY KEY,
  company TEXT NOT NULL,
  cik TEXT,
  exchange TEXT,
  investor_relations_url TEXT,
  index_memberships TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(index_memberships)),
  metadata_provider TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS earnings_events (
  id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  company TEXT NOT NULL,
  cik TEXT,
  fiscal_year INTEGER,
  fiscal_quarter INTEGER CHECK (fiscal_quarter IS NULL OR fiscal_quarter BETWEEN 1 AND 4),
  fiscal_period TEXT,
  fiscal_period_end TEXT,
  scheduled_date TEXT,
  scheduled_time TEXT,
  timing TEXT NOT NULL CHECK (timing IN ('BMO', 'AMC', 'TBD')),
  status TEXT NOT NULL CHECK (status IN ('scheduled', 'reported', 'cancelled', 'unknown')),
  scheduled INTEGER NOT NULL DEFAULT 0 CHECK (scheduled IN (0, 1)),
  reported INTEGER NOT NULL DEFAULT 0 CHECK (reported IN (0, 1)),
  cancelled INTEGER NOT NULL DEFAULT 0 CHECK (cancelled IN (0, 1)),
  unknown INTEGER NOT NULL DEFAULT 0 CHECK (unknown IN (0, 1)),
  eps_estimate REAL,
  eps_actual REAL,
  eps_surprise REAL,
  eps_surprise_pct REAL,
  eps_result TEXT NOT NULL DEFAULT 'Not Available' CHECK (eps_result IN ('Beat', 'In Line', 'Miss', 'Not Available')),
  revenue_estimate REAL,
  revenue_actual REAL,
  revenue_surprise REAL,
  revenue_surprise_pct REAL,
  revenue_result TEXT NOT NULL DEFAULT 'Not Available' CHECK (revenue_result IN ('Beat', 'In Line', 'Miss', 'Not Available')),
  overall_result TEXT NOT NULL DEFAULT 'Not Available' CHECK (overall_result IN ('Beat', 'In Line', 'Miss', 'Mixed', 'Not Available')),
  reported_at TEXT,
  calendar_provider TEXT,
  consensus_provider TEXT,
  provider_event_id TEXT,
  provider_updated_at TEXT,
  official_report_url TEXT,
  investor_relations_url TEXT,
  sec_filing_url TEXT,
  sec_accession TEXT,
  sec_form TEXT,
  sec_filed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_checked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_earnings_events_schedule
  ON earnings_events (scheduled_date, status, symbol);
CREATE INDEX IF NOT EXISTS idx_earnings_events_history
  ON earnings_events (status, scheduled_date DESC, symbol);
CREATE INDEX IF NOT EXISTS idx_earnings_events_symbol
  ON earnings_events (symbol, scheduled_date DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_earnings_events_provider_id
  ON earnings_events (provider_event_id)
  WHERE provider_event_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_earnings_events_fiscal_identity
  ON earnings_events (symbol, fiscal_year, fiscal_quarter)
  WHERE fiscal_year IS NOT NULL AND fiscal_quarter IS NOT NULL;
