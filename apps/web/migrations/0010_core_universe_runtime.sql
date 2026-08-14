-- 0010_core_universe_runtime.sql — Core Universe lifecycle on the existing
-- Earnings universe table. Historical earnings_events are intentionally not
-- changed or deleted by this migration.
PRAGMA foreign_keys = ON;

ALTER TABLE earnings_universe ADD COLUMN active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1));
ALTER TABLE earnings_universe ADD COLUMN source TEXT NOT NULL DEFAULT 'core' CHECK (source IN ('core', 'trending'));
ALTER TABLE earnings_universe ADD COLUMN universe_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE earnings_universe ADD COLUMN added_at TEXT;
ALTER TABLE earnings_universe ADD COLUMN removed_at TEXT;

-- Existing production rows are the legacy S&P 500/Nasdaq-100 bootstrap. Keep
-- their metadata and prior update time as the best known initial membership
-- timestamp, but fail closed until the first Core reconciliation. That sync
-- activates the configured members and stamps removed_at on every legacy row
-- absent from the checked-in Core file.
UPDATE earnings_universe
SET added_at = COALESCE(added_at, updated_at),
    source = 'core',
    active = 0,
    universe_version = 0
WHERE added_at IS NULL OR source IS NULL OR active IS NULL;

CREATE INDEX IF NOT EXISTS idx_earnings_universe_active_source
  ON earnings_universe (source, active, symbol);
