-- 0018_manual_intrinsic_values.sql — Screener manual intrinsic value (IV).
--
-- Durable, auditable store for manual intrinsic value estimates per symbol.
-- Each row is one (symbol, method) tuple with low/base/high range values.
--
-- In this PR the only method is 'manual' (human-defined, reference date
-- 2026-08-03, 17 symbols, low/high both NULL). The schema is method-agnostic
-- so future methods can coexist without a schema change.
--
-- `base_value` is the primary IV. `low_value` / `high_value` are optional and
-- prepared for a future Stock Detail Page — both NULL in this first version.
--
-- Idempotent UPSERT keyed by (symbol, method); safe to re-run.
-- No FK to other tables: keeps fresh bootstrap and partial-migration states
-- healthy. The dataset is tiny (<= 17 rows here); no extra indexes beyond PK.

CREATE TABLE IF NOT EXISTS stock_intrinsic_values (
  symbol TEXT NOT NULL,
  method TEXT NOT NULL,
  low_value REAL NULL,
  base_value REAL NOT NULL CHECK (base_value > 0),
  high_value REAL NULL,
  as_of_date TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (symbol, method),
  CHECK (low_value IS NULL OR low_value > 0),
  CHECK (high_value IS NULL OR high_value > 0),
  CHECK (low_value IS NULL OR low_value <= base_value),
  CHECK (high_value IS NULL OR base_value <= high_value)
);

-- Manual intrinsic values — reference date 2026-08-03.
-- Idempotent: re-running this migration leaves the same 17 rows.
INSERT OR REPLACE INTO stock_intrinsic_values (symbol, method, low_value, base_value, high_value, as_of_date, updated_at) VALUES
('AAPL', 'manual', NULL, 251.12, NULL, '2026-08-03', '2026-08-03T00:00:00.000Z'),
('AMZN', 'manual', NULL, 233.00, NULL, '2026-08-03', '2026-08-03T00:00:00.000Z'),
('GOOGL', 'manual', NULL, 316.55, NULL, '2026-08-03', '2026-08-03T00:00:00.000Z'),
('MA', 'manual', NULL, 571.00, NULL, '2026-08-03', '2026-08-03T00:00:00.000Z'),
('META', 'manual', NULL, 906.66, NULL, '2026-08-03', '2026-08-03T00:00:00.000Z'),
('MSFT', 'manual', NULL, 570.31, NULL, '2026-08-03', '2026-08-03T00:00:00.000Z'),
('NVDA', 'manual', NULL, 221.02, NULL, '2026-08-03', '2026-08-03T00:00:00.000Z'),
('PANW', 'manual', NULL, 202.00, NULL, '2026-08-03', '2026-08-03T00:00:00.000Z'),
('ASML', 'manual', NULL, 1338.35, NULL, '2026-08-03', '2026-08-03T00:00:00.000Z'),
('AVGO', 'manual', NULL, 422.89, NULL, '2026-08-03', '2026-08-03T00:00:00.000Z'),
('CRWD', 'manual', NULL, 101.80, NULL, '2026-08-03', '2026-08-03T00:00:00.000Z'),
('NFLX', 'manual', NULL, 81.75, NULL, '2026-08-03', '2026-08-03T00:00:00.000Z'),
('NOW', 'manual', NULL, 204.49, NULL, '2026-08-03', '2026-08-03T00:00:00.000Z'),
('NVO', 'manual', NULL, 72.96, NULL, '2026-08-03', '2026-08-03T00:00:00.000Z'),
('PLTR', 'manual', NULL, 143.08, NULL, '2026-08-03', '2026-08-03T00:00:00.000Z'),
('UNH', 'manual', NULL, 437.59, NULL, '2026-08-03', '2026-08-03T00:00:00.000Z'),
('V', 'manual', NULL, 335.87, NULL, '2026-08-03', '2026-08-03T00:00:00.000Z');
