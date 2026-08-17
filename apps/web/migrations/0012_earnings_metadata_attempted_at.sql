-- 0012_earnings_metadata_attempted_at.sql — Finnhub profile attempt cooldown
--
-- Per-symbol last profile-attempt stamp so the maintenance cap (2/run) cannot
-- be monopolised by alphabetically-early symbols that fail or return partial
-- profiles forever. Additive only: existing rows keep NULL (never attempted)
-- and remain eligible immediately.
PRAGMA foreign_keys = ON;

ALTER TABLE earnings_universe ADD COLUMN metadata_attempted_at TEXT;
