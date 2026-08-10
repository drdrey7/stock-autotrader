-- 0001_initial.sql — Stock Autotrader public read model (PR #2)
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stocks (
  symbol TEXT PRIMARY KEY,
  company TEXT NOT NULL,
  sector TEXT,
  market_cap INTEGER,
  price REAL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS strategies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL,
  description TEXT,
  universe TEXT,
  typical_holding_period TEXT,
  signals_today INTEGER NOT NULL DEFAULT 0,
  open_shadow_positions INTEGER NOT NULL DEFAULT 0,
  metadata TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scanned_at TEXT NOT NULL,
  universe INTEGER NOT NULL,
  passed_filters INTEGER NOT NULL,
  candidates INTEGER NOT NULL,
  setups INTEGER NOT NULL,
  watch INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS scan_candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scan_id INTEGER NOT NULL REFERENCES scans(id),
  symbol TEXT NOT NULL,
  company TEXT,
  sector TEXT,
  market_cap INTEGER,
  price REAL,
  quant_score INTEGER NOT NULL,
  strategy_id TEXT NOT NULL,
  strategy TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  trend TEXT,
  momentum REAL,
  relative_strength REAL,
  relative_volume REAL,
  breakout TEXT,
  earnings_date TEXT,
  earnings_proximity_days INTEGER,
  status TEXT NOT NULL,
  direction TEXT NOT NULL,
  risk_flags TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scan_candidates_scan ON scan_candidates(scan_id);

CREATE TABLE IF NOT EXISTS decision_reasons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER NOT NULL REFERENCES scan_candidates(id),
  reason_code TEXT NOT NULL,
  reason_label TEXT NOT NULL,
  outcome TEXT NOT NULL,
  observed TEXT,
  threshold TEXT
);
CREATE INDEX IF NOT EXISTS idx_decision_reasons_candidate ON decision_reasons(candidate_id);

CREATE TABLE IF NOT EXISTS earnings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  company TEXT NOT NULL,
  date TEXT NOT NULL,
  timing TEXT NOT NULL,
  event_signal TEXT NOT NULL,
  engine_relevant INTEGER NOT NULL DEFAULT 0,
  signal TEXT,
  strategy TEXT,
  has_position INTEGER NOT NULL DEFAULT 0,
  tracked INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS shadow_positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  strategy TEXT NOT NULL,
  entry_price REAL NOT NULL,
  current_price REAL NOT NULL,
  stop_price REAL NOT NULL,
  quantity INTEGER NOT NULL,
  risk_amount REAL NOT NULL,
  unrealized_pnl REAL NOT NULL,
  return_pct REAL NOT NULL,
  r_multiple REAL NOT NULL,
  opened_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bot_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  message TEXT NOT NULL,
  severity TEXT NOT NULL,
  symbol TEXT,
  strategy_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bot_events_created ON bot_events(created_at DESC);

CREATE TABLE IF NOT EXISTS research (
  id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL,
  strategy TEXT NOT NULL,
  stage TEXT NOT NULL,
  period TEXT NOT NULL,
  status TEXT NOT NULL,
  metrics TEXT NOT NULL
);
