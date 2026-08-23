-- 0028_ai_analysis.sql — globally shared TradingAgents analyses, per-user
-- acquisitions, credit entitlements, and a transactional Queue outbox.
--
-- All timestamps are canonical UTC ISO-8601 TEXT values with milliseconds
-- and a trailing Z. That makes ordinary lexical comparisons chronological.
-- Credit accounting deliberately lives outside Better Auth's tables.
PRAGMA foreign_keys = ON;

CREATE TABLE user_ai_entitlements (
  user_id TEXT PRIMARY KEY NOT NULL,
  credits_remaining INTEGER NOT NULL DEFAULT 1 CHECK (credits_remaining >= 0),
  credits_granted INTEGER NOT NULL DEFAULT 1 CHECK (credits_granted >= 0),
  credits_used INTEGER NOT NULL DEFAULT 0 CHECK (credits_used >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES `user` (id) ON UPDATE NO ACTION ON DELETE CASCADE
);

-- Existing accounts receive the same one-credit entitlement as future ones.
INSERT INTO user_ai_entitlements (
  user_id,
  credits_remaining,
  credits_granted,
  credits_used,
  created_at,
  updated_at
)
SELECT
  id,
  1,
  1,
  0,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM `user`
WHERE 1
ON CONFLICT (user_id) DO NOTHING;

CREATE TRIGGER user_ai_entitlements_after_user_insert
AFTER INSERT ON `user`
FOR EACH ROW
BEGIN
  INSERT INTO user_ai_entitlements (
    user_id,
    credits_remaining,
    credits_granted,
    credits_used,
    created_at,
    updated_at
  ) VALUES (
    NEW.id,
    1,
    1,
    0,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  ) ON CONFLICT (user_id) DO NOTHING;
END;

CREATE TABLE ai_analyses (
  id TEXT PRIMARY KEY NOT NULL,
  symbol TEXT NOT NULL CHECK (
    length(symbol) BETWEEN 1 AND 12
    AND symbol = upper(symbol)
    AND symbol NOT GLOB '*[^A-Z0-9-]*'
  ),
  status TEXT NOT NULL CHECK (status IN ('dispatching', 'queued', 'running', 'completed', 'failed')),
  analysis_date TEXT NOT NULL CHECK (
    length(analysis_date) = 10
    AND analysis_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  ),
  engine TEXT NOT NULL,
  engine_version TEXT NOT NULL,
  result_schema_version INTEGER NOT NULL DEFAULT 1 CHECK (result_schema_version >= 1),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  valid_until TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  execution_token TEXT,
  execution_message_id TEXT,
  heartbeat_at TEXT,
  safe_error_code TEXT CHECK (safe_error_code IS NULL OR length(safe_error_code) BETWEEN 1 AND 64),
  safe_error_message TEXT CHECK (safe_error_message IS NULL OR length(safe_error_message) BETWEEN 1 AND 512),
  updated_at TEXT NOT NULL,
  CHECK (
    (status = 'completed'
      AND result_json IS NOT NULL
      AND completed_at IS NOT NULL
      AND valid_until IS NOT NULL)
    OR
    (status <> 'completed'
      AND result_json IS NULL
      AND completed_at IS NULL
      AND valid_until IS NULL)
  )
);

-- This is the global computation lock. SQLite/D1 serializes writers and the
-- partial unique index is the final authority when requests arrive together.
CREATE UNIQUE INDEX idx_ai_analyses_one_active_per_symbol
  ON ai_analyses (symbol)
  WHERE status IN ('dispatching', 'queued', 'running');

CREATE INDEX idx_ai_analyses_reusable
  ON ai_analyses (symbol, completed_at DESC, valid_until)
  WHERE status = 'completed';

CREATE INDEX idx_ai_analyses_status_heartbeat
  ON ai_analyses (status, heartbeat_at);

CREATE TABLE user_ai_analysis_runs (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  analysis_id TEXT NOT NULL,
  symbol TEXT NOT NULL CHECK (
    length(symbol) BETWEEN 1 AND 12
    AND symbol = upper(symbol)
    AND symbol NOT GLOB '*[^A-Z0-9-]*'
  ),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  credit_cost INTEGER NOT NULL DEFAULT 1 CHECK (credit_cost IN (0, 1)),
  requested_at TEXT NOT NULL,
  acquired_at TEXT,
  credit_refunded_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES `user` (id) ON UPDATE NO ACTION ON DELETE CASCADE,
  FOREIGN KEY (analysis_id) REFERENCES ai_analyses (id) ON UPDATE NO ACTION ON DELETE RESTRICT,
  CHECK (
    (status = 'completed' AND acquired_at IS NOT NULL AND credit_refunded_at IS NULL)
    OR
    (status IN ('queued', 'running') AND acquired_at IS NULL AND credit_refunded_at IS NULL)
    OR
    (status = 'failed' AND acquired_at IS NULL)
  ),
  CHECK (credit_refunded_at IS NULL OR (status = 'failed' AND credit_cost = 1))
);

CREATE UNIQUE INDEX idx_user_ai_analysis_runs_idempotency
  ON user_ai_analysis_runs (user_id, idempotency_key);

CREATE UNIQUE INDEX idx_user_ai_analysis_runs_ownership
  ON user_ai_analysis_runs (user_id, analysis_id);

-- Protects double-clicks that somehow carry different keys while the same
-- user's symbol is still active. Historical completed runs are unaffected.
CREATE UNIQUE INDEX idx_user_ai_analysis_runs_one_active_symbol
  ON user_ai_analysis_runs (user_id, symbol)
  WHERE status IN ('queued', 'running');

CREATE INDEX idx_user_ai_analysis_runs_history
  ON user_ai_analysis_runs (user_id, acquired_at DESC, id DESC)
  WHERE status = 'completed';

CREATE INDEX idx_user_ai_analysis_runs_analysis
  ON user_ai_analysis_runs (analysis_id, status);

CREATE TABLE ai_analysis_dispatches (
  id TEXT PRIMARY KEY NOT NULL,
  analysis_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
  claim_token TEXT,
  claim_expires_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  sent_at TEXT,
  last_error_code TEXT CHECK (last_error_code IS NULL OR length(last_error_code) BETWEEN 1 AND 64),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (analysis_id) REFERENCES ai_analyses (id) ON UPDATE NO ACTION ON DELETE CASCADE,
  CHECK (status <> 'sent' OR sent_at IS NOT NULL)
);

CREATE INDEX idx_ai_analysis_dispatches_claimable
  ON ai_analysis_dispatches (status, claim_expires_at, created_at);

-- Every canonical row and its outbox record are born in the same D1
-- transaction. A failed user-run insert rolls both back with the batch.
CREATE TRIGGER ai_analysis_dispatch_after_analysis_insert
AFTER INSERT ON ai_analyses
FOR EACH ROW
BEGIN
  INSERT INTO ai_analysis_dispatches (
    id,
    analysis_id,
    status,
    attempt_count,
    created_at,
    updated_at
  ) VALUES (
    NEW.id,
    NEW.id,
    'pending',
    0,
    NEW.created_at,
    NEW.updated_at
  );
END;

-- IMPORTANT: API acquisition must use a plain INSERT, never INSERT OR IGNORE.
-- A uniqueness failure then aborts the statement and rolls this trigger's
-- debit back. D1 batch() also rolls back any speculative canonical/outbox.
CREATE TRIGGER user_ai_analysis_runs_before_insert_debit
BEFORE INSERT ON user_ai_analysis_runs
FOR EACH ROW
WHEN NEW.credit_cost = 1
BEGIN
  UPDATE user_ai_entitlements
  SET credits_remaining = credits_remaining - 1,
      credits_used = credits_used + 1,
      updated_at = NEW.requested_at
  WHERE user_id = NEW.user_id
    AND credits_remaining > 0;

  SELECT CASE
    WHEN changes() <> 1 THEN RAISE(ABORT, 'ai_credit_exhausted')
  END;
END;

-- Terminal analyses may never be resurrected or overwritten. Retriable work
-- may move running -> queued; all other allowed transitions are explicit.
CREATE TRIGGER ai_analyses_before_invalid_status_transition
BEFORE UPDATE OF status ON ai_analyses
FOR EACH ROW
WHEN NOT (
  NEW.status = OLD.status
  OR (OLD.status = 'dispatching' AND NEW.status IN ('queued', 'failed'))
  OR (OLD.status = 'queued' AND NEW.status IN ('running', 'failed'))
  OR (OLD.status = 'running' AND NEW.status IN ('queued', 'completed', 'failed'))
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_ai_analysis_status_transition');
END;

CREATE TRIGGER user_ai_analysis_runs_before_invalid_status_transition
BEFORE UPDATE OF status ON user_ai_analysis_runs
FOR EACH ROW
WHEN NOT (
  NEW.status = OLD.status
  OR (OLD.status = 'queued' AND NEW.status IN ('running', 'completed', 'failed'))
  OR (OLD.status = 'running' AND NEW.status IN ('queued', 'completed', 'failed'))
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_user_ai_analysis_run_status_transition');
END;

CREATE TRIGGER ai_analyses_after_queued
AFTER UPDATE OF status ON ai_analyses
FOR EACH ROW
WHEN NEW.status = 'queued' AND OLD.status = 'running'
BEGIN
  UPDATE user_ai_analysis_runs
  SET status = 'queued',
      updated_at = NEW.updated_at
  WHERE analysis_id = NEW.id
    AND status = 'running';
END;

CREATE TRIGGER ai_analyses_after_running
AFTER UPDATE OF status ON ai_analyses
FOR EACH ROW
WHEN NEW.status = 'running' AND OLD.status <> 'running'
BEGIN
  UPDATE user_ai_analysis_runs
  SET status = 'running',
      updated_at = NEW.updated_at
  WHERE analysis_id = NEW.id
    AND status = 'queued';
END;

CREATE TRIGGER ai_analyses_after_completed
AFTER UPDATE OF status ON ai_analyses
FOR EACH ROW
WHEN NEW.status = 'completed' AND OLD.status <> 'completed'
BEGIN
  UPDATE user_ai_analysis_runs
  SET status = 'completed',
      acquired_at = NEW.completed_at,
      updated_at = NEW.updated_at
  WHERE analysis_id = NEW.id
    AND status IN ('queued', 'running');
END;

-- Refund every still-pending acquisition exactly once. The canonical status
-- transition is terminal and each (user, analysis) pair is unique; the
-- credit_refunded_at predicate additionally makes manual/replayed updates safe.
CREATE TRIGGER ai_analyses_after_failed
AFTER UPDATE OF status ON ai_analyses
FOR EACH ROW
WHEN NEW.status = 'failed' AND OLD.status <> 'failed'
BEGIN
  UPDATE user_ai_entitlements
  SET credits_remaining = credits_remaining + 1,
      credits_used = CASE WHEN credits_used > 0 THEN credits_used - 1 ELSE 0 END,
      updated_at = NEW.updated_at
  WHERE EXISTS (
    SELECT 1
    FROM user_ai_analysis_runs AS run
    WHERE run.analysis_id = NEW.id
      AND run.user_id = user_ai_entitlements.user_id
      AND run.status IN ('queued', 'running')
      AND run.credit_cost = 1
      AND run.credit_refunded_at IS NULL
  );

  UPDATE user_ai_analysis_runs
  SET status = 'failed',
      credit_refunded_at = CASE
        WHEN credit_cost = 1 AND credit_refunded_at IS NULL THEN NEW.updated_at
        ELSE credit_refunded_at
      END,
      updated_at = NEW.updated_at
  WHERE analysis_id = NEW.id
    AND status IN ('queued', 'running');
END;
