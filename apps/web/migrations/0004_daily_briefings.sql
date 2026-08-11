-- 0004_daily_briefings.sql — DailyBriefing v1 append-only read model (PR #7)
-- Additive migration. Do not apply to production automatically.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS daily_briefings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  edition_date TEXT NOT NULL,
  edition_type TEXT NOT NULL CHECK (edition_type IN ('pre_market', 'post_close')),
  timezone TEXT NOT NULL CHECK (timezone = 'America/New_York'),
  prepared_at TEXT NOT NULL,
  published_at TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  UNIQUE (edition_date, edition_type)
);

CREATE INDEX IF NOT EXISTS idx_daily_briefings_published
  ON daily_briefings(published_at DESC, id DESC);
