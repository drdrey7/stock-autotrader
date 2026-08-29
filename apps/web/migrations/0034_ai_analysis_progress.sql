-- Durable, low-volume graph progress for the user-visible AI Analysis run.
-- Progress is advisory and is protected by the runner's existing execution
-- token/message CAS; it never contains prompts, responses, or reasoning.
ALTER TABLE ai_analyses ADD COLUMN progress_stage TEXT;
ALTER TABLE ai_analyses ADD COLUMN progress_step INTEGER NOT NULL DEFAULT 0 CHECK (progress_step >= 0);
ALTER TABLE ai_analyses ADD COLUMN progress_total INTEGER NOT NULL DEFAULT 12 CHECK (progress_total >= 1);
ALTER TABLE ai_analyses ADD COLUMN progress_updated_at TEXT;
