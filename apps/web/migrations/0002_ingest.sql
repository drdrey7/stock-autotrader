-- 0002_ingest.sql — protected publication layer (PR #3)
PRAGMA foreign_keys = ON;

-- Idempotency ledger: one row per accepted event_id (dedupe + audit)
CREATE TABLE IF NOT EXISTS ingest_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  received_at TEXT NOT NULL,
  status TEXT NOT NULL
);

-- Publication log (audit trail)
CREATE TABLE IF NOT EXISTS ingest_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ingest_log_created ON ingest_log(created_at DESC);
