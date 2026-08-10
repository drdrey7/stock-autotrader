PRAGMA foreign_keys = ON;

CREATE TABLE stocks (
  symbol TEXT PRIMARY KEY,
  company TEXT NOT NULL,
  exchange TEXT NOT NULL,
  sector TEXT,
  industry TEXT,
  security_type TEXT NOT NULL DEFAULT 'COMMON_STOCK' CHECK (security_type IN ('COMMON_STOCK','ETF','PREFERRED','WARRANT','RIGHT','UNIT','OTHER')),
  market_cap REAL,
  price REAL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  data_source TEXT NOT NULL,
  source_updated_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE strategies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  description TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('Research','Validation','Out-of-Sample','Shadow','Live')),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  universe TEXT NOT NULL,
  holding_period TEXT NOT NULL,
  parameters_json TEXT NOT NULL DEFAULT '{}',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (name, version)
);

CREATE TABLE scans (
  id TEXT PRIMARY KEY,
  scan_type TEXT NOT NULL CHECK (scan_type IN ('PRE_MARKET','POST_CLOSE','MANUAL','SMOKE')),
  status TEXT NOT NULL CHECK (status IN ('STARTED','COMPLETED','FAILED')),
  strategy_versions_json TEXT NOT NULL DEFAULT '{}',
  universe_count INTEGER NOT NULL DEFAULT 0,
  passed_filters_count INTEGER NOT NULL DEFAULT 0,
  candidates_count INTEGER NOT NULL DEFAULT 0,
  setups_count INTEGER NOT NULL DEFAULT 0,
  data_source TEXT NOT NULL,
  data_as_of TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE scan_candidates (
  id TEXT PRIMARY KEY,
  scan_id TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL REFERENCES stocks(symbol),
  strategy_id TEXT NOT NULL REFERENCES strategies(id),
  strategy_version TEXT NOT NULL,
  price REAL NOT NULL,
  quant_score REAL NOT NULL CHECK (quant_score BETWEEN 0 AND 100),
  trend TEXT NOT NULL,
  momentum REAL NOT NULL,
  relative_strength REAL NOT NULL,
  relative_volume REAL NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('Strong Setup','Watch','No Setup','Rejected')),
  direction TEXT NOT NULL CHECK (direction IN ('Bullish','Neutral','Bearish')),
  feature_snapshot_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (scan_id, symbol, strategy_id, strategy_version)
);

CREATE TABLE signals (
  id TEXT PRIMARY KEY,
  scan_candidate_id TEXT NOT NULL REFERENCES scan_candidates(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL REFERENCES stocks(symbol),
  strategy_id TEXT NOT NULL REFERENCES strategies(id),
  strategy_version TEXT NOT NULL,
  signal TEXT NOT NULL CHECK (signal IN ('Strong Setup','Watch','No Setup','Rejected')),
  direction TEXT NOT NULL CHECK (direction IN ('Bullish','Neutral','Bearish')),
  quant_score REAL NOT NULL CHECK (quant_score BETWEEN 0 AND 100),
  signal_at TEXT NOT NULL,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE analyses (
  id TEXT PRIMARY KEY,
  signal_id TEXT REFERENCES signals(id) ON DELETE SET NULL,
  symbol TEXT NOT NULL REFERENCES stocks(symbol),
  strategy_id TEXT REFERENCES strategies(id),
  strategy_version TEXT,
  quant_factors_json TEXT NOT NULL,
  market_structure_json TEXT NOT NULL DEFAULT '{}',
  public_summary TEXT NOT NULL,
  ai_assessment_json TEXT,
  data_source TEXT NOT NULL,
  data_as_of TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE decision_reasons (
  id TEXT PRIMARY KEY,
  analysis_id TEXT NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
  outcome TEXT NOT NULL CHECK (outcome IN ('pass','reject','info')),
  code TEXT NOT NULL,
  label TEXT NOT NULL,
  observed_value TEXT,
  threshold_value TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE earnings (
  id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL REFERENCES stocks(symbol),
  event_date TEXT NOT NULL,
  timing TEXT NOT NULL DEFAULT 'TBD' CHECK (timing IN ('BMO','AMC','TBD')),
  fiscal_period TEXT,
  eps_actual REAL,
  eps_estimate REAL,
  revenue_actual REAL,
  revenue_estimate REAL,
  event_status TEXT NOT NULL DEFAULT 'SCHEDULED',
  data_source TEXT NOT NULL,
  source_updated_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (symbol, event_date, fiscal_period)
);

CREATE TABLE news_events (
  id TEXT PRIMARY KEY,
  symbol TEXT REFERENCES stocks(symbol),
  event_type TEXT NOT NULL,
  headline TEXT NOT NULL,
  summary TEXT,
  source_name TEXT NOT NULL,
  source_url TEXT NOT NULL,
  published_at TEXT NOT NULL,
  available_at TEXT NOT NULL,
  material INTEGER NOT NULL DEFAULT 0 CHECK (material IN (0,1)),
  ai_assessment_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE shadow_portfolios (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  initial_capital REAL NOT NULL CHECK (initial_capital > 0),
  cash REAL NOT NULL,
  equity REAL NOT NULL,
  risk_per_trade_pct REAL NOT NULL,
  max_positions INTEGER NOT NULL,
  max_open_risk_pct REAL NOT NULL,
  max_gross_exposure_pct REAL NOT NULL,
  max_single_position_pct REAL NOT NULL,
  max_sector_exposure_pct REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  started_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE shadow_positions (
  id TEXT PRIMARY KEY,
  portfolio_id TEXT NOT NULL REFERENCES shadow_portfolios(id),
  symbol TEXT NOT NULL REFERENCES stocks(symbol),
  strategy_id TEXT NOT NULL REFERENCES strategies(id),
  strategy_version TEXT NOT NULL,
  signal_id TEXT REFERENCES signals(id),
  sector TEXT,
  entry_price REAL NOT NULL,
  current_price REAL NOT NULL,
  stop_price REAL NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  initial_risk REAL NOT NULL,
  unrealized_pnl REAL NOT NULL DEFAULT 0,
  r_multiple REAL NOT NULL DEFAULT 0,
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('OPEN','CLOSED')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE shadow_trades (
  id TEXT PRIMARY KEY,
  portfolio_id TEXT NOT NULL REFERENCES shadow_portfolios(id),
  position_id TEXT NOT NULL REFERENCES shadow_positions(id),
  symbol TEXT NOT NULL REFERENCES stocks(symbol),
  strategy_id TEXT NOT NULL REFERENCES strategies(id),
  strategy_version TEXT NOT NULL,
  signal_id TEXT REFERENCES signals(id),
  entry_price REAL NOT NULL,
  exit_price REAL,
  stop_price REAL NOT NULL,
  quantity INTEGER NOT NULL,
  initial_risk REAL NOT NULL,
  realized_pnl REAL,
  r_multiple REAL,
  entry_at TEXT NOT NULL,
  exit_at TEXT,
  exit_reason TEXT,
  cost_scenario TEXT NOT NULL DEFAULT 'NORMAL',
  simulated INTEGER NOT NULL DEFAULT 1 CHECK (simulated = 1),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE backtests (
  id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL REFERENCES strategies(id),
  strategy_version TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('Research','Validation','Out-of-Sample','Shadow','Live')),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  cost_scenario TEXT NOT NULL CHECK (cost_scenario IN ('LOW_COST','NORMAL','STRESS')),
  benchmark_symbols_json TEXT NOT NULL DEFAULT '["SPY","QQQ"]',
  parameters_json TEXT NOT NULL,
  metrics_json TEXT NOT NULL,
  data_source TEXT NOT NULL,
  universe_method TEXT NOT NULL,
  code_version TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE bot_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL CHECK (event_type IN ('SCAN_STARTED','UNIVERSE_LOADED','FILTER_COMPLETED','RANKING_COMPLETED','CANDIDATE_SELECTED','ANALYSIS_STARTED','ANALYSIS_COMPLETED','SIGNAL_CREATED','SIGNAL_REJECTED','SHADOW_TRADE_OPENED','SHADOW_TRADE_CLOSED','SCAN_COMPLETED','ERROR')),
  severity TEXT NOT NULL CHECK (severity IN ('info','success','warning','error')),
  public_message TEXT NOT NULL,
  symbol TEXT REFERENCES stocks(symbol),
  strategy_id TEXT REFERENCES strategies(id),
  strategy_version TEXT,
  scan_id TEXT REFERENCES scans(id),
  public_metadata_json TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_scans_completed ON scans(completed_at DESC);
CREATE INDEX idx_candidates_scan_score ON scan_candidates(scan_id, quant_score DESC);
CREATE INDEX idx_signals_symbol_time ON signals(symbol, signal_at DESC);
CREATE INDEX idx_analyses_symbol_time ON analyses(symbol, data_as_of DESC);
CREATE INDEX idx_reasons_analysis_sort ON decision_reasons(analysis_id, sort_order);
CREATE INDEX idx_earnings_date ON earnings(event_date, symbol);
CREATE INDEX idx_news_symbol_available ON news_events(symbol, available_at DESC);
CREATE INDEX idx_positions_portfolio_status ON shadow_positions(portfolio_id, status);
CREATE INDEX idx_trades_portfolio_entry ON shadow_trades(portfolio_id, entry_at DESC);
CREATE INDEX idx_backtests_strategy_stage ON backtests(strategy_id, strategy_version, stage);
CREATE INDEX idx_events_time ON bot_events(occurred_at DESC);

