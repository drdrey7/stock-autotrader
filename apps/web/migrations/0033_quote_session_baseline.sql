-- Persist regular-session provenance for latest_quotes daily-change semantics.
--
-- Existing quote rows are intentionally NOT trusted for previous_close provenance:
-- daily_change_valid starts false for every row. quote_session_date is backfilled
-- from the WebSocket trade timestamp so the first post-rollout session can promote
-- the immediately prior regular-session close without inventing a baseline.
ALTER TABLE latest_quotes ADD COLUMN quote_session_date TEXT;
ALTER TABLE latest_quotes ADD COLUMN previous_close_session_date TEXT;
ALTER TABLE latest_quotes ADD COLUMN daily_change_valid INTEGER NOT NULL DEFAULT 0
  CHECK (daily_change_valid IN (0, 1));

UPDATE latest_quotes
SET quote_session_date = substr(provider_timestamp, 1, 10)
WHERE quote_session_date IS NULL
  AND provider = 'finnhub-websocket'
  AND provider_timestamp GLOB '????-??-??T*';
