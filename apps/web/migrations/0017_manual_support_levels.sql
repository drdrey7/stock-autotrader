-- 0017_manual_support_levels.sql — Screener manual support levels (S1-S4).
--
-- Durable, auditable store for support levels per symbol. Each row is one
-- level (1..4) tagged with its computation method and reference date.
--
-- In this PR the only method is 'manual' (human-defined, reference date
-- 2026-08-03, 17 symbols, 61 levels). The schema is method-agnostic so
-- future 'automatic' methods can coexist without a schema change.
--
-- `triggered` is NOT persisted — it is always derived at read time from the
-- latest quote (currentPrice <= supportPrice) and is therefore a Worker-side
-- concern, never a storage concern.
--
-- Idempotent UPSERT keyed by (symbol, method, level); safe to re-run.
-- No FK to other tables: keeps fresh bootstrap and partial-migration states
-- healthy. The dataset is tiny (<= 61 rows here); no extra indexes beyond PK.

CREATE TABLE IF NOT EXISTS stock_support_levels (
  symbol TEXT NOT NULL,
  method TEXT NOT NULL,
  level INTEGER NOT NULL CHECK (level BETWEEN 1 AND 4),
  price REAL NOT NULL CHECK (price > 0),
  as_of_date TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (symbol, method, level)
);

-- Manual support levels — reference date 2026-08-03.
-- Idempotent: re-running this migration leaves the same 61 rows.
INSERT OR REPLACE INTO stock_support_levels (symbol, method, level, price, as_of_date, updated_at) VALUES
-- AAPL (4 levels)
('AAPL', 'manual', 1, 246, '2026-08-03', '2026-08-03T00:00:00.000Z'),
('AAPL', 'manual', 2, 228, '2026-08-03', '2026-08-03T00:00:00.000Z'),
('AAPL', 'manual', 3, 212, '2026-08-03', '2026-08-03T00:00:00.000Z'),
('AAPL', 'manual', 4, 196, '2026-08-03', '2026-08-03T00:00:00.000Z'),
-- AMZN (4 levels)
('AMZN', 'manual', 1, 221, '2026-08-03', '2026-08-03T00:00:00.000Z'),
('AMZN', 'manual', 2, 200, '2026-08-03', '2026-08-03T00:00:00.000Z'),
('AMZN', 'manual', 3, 175, '2026-08-03', '2026-08-03T00:00:00.000Z'),
('AMZN', 'manual', 4, 149, '2026-08-03', '2026-08-03T00:00:00.000Z'),
-- ASML (3 levels)
('ASML', 'manual', 1, 1219, '2026-08-03', '2026-08-03T00:00:00.000Z'),
('ASML', 'manual', 2, 1004, '2026-08-03', '2026-08-03T00:00:00.000Z'),
('ASML', 'manual', 3, 855, '2026-08-03', '2026-08-03T00:00:00.000Z'),
-- AVGO (4 levels)
('AVGO', 'manual', 1, 361, '2026-08-03', '2026-08-03T00:00:00.000Z'),
('AVGO', 'manual', 2, 326, '2026-08-03', '2026-08-03T00:00:00.000Z'),
('AVGO', 'manual', 3, 289, '2026-08-03', '2026-08-03T00:00:00.000Z'),
('AVGO', 'manual', 4, 251, '2026-08-03', '2026-08-03T00:00:00.000Z'),
-- CRWD (3 levels)
('CRWD', 'manual', 1, 93, '2026-08-03', '2026-08-03T00:00:00.000Z'),
('CRWD', 'manual', 2, 85, '2026-08-03', '2026-08-03T00:00:00.000Z'),
('CRWD', 'manual', 3, 75, '2026-08-03', '2026-08-03T00:00:00.000Z'),
-- GOOGL (4 levels)
('GOOGL', 'manual', 1, 295, '2026-08-03', '2026-08-03T00:00:00.000Z'),
('GOOGL', 'manual', 2, 275, '2026-08-03', '2026-08-03T00:00:00.000Z'),
('GOOGL', 'manual', 3, 256, '2026-08-03', '2026-08-03T00:00:00.000Z'),
('GOOGL', 'manual', 4, 236, '2026-08-03', '2026-08-03T00:00:00.000Z'),
-- MA (4 levels)
('MA', 'manual', 1, 527, '2026-08-03', '2026-08-03T00:00:00.000Z'),
('MA', 'manual', 2, 501, '2026-08-03', '2026-08-03T00:00:00.000Z'),
('MA', 'manual', 3, 464, '2026-08-03', '2026-08-03T00:00:00.000Z'),
('MA', 'manual', 4, 428, '2026-08-03', '2026-08-03T00:00:00.000Z'),
-- META (4 levels)
('META', 'manual', 1, 635, '2026-08-03', '2026-08-03T00:00:00.000Z'),
('META', 'manual', 2, 580, '2026-08-03', '2026-08-03T00:00:00.000Z'),
('META', 'manual', 3, 532, '2026-08-03', '2026-08-03T00:00:00.000Z'),
('META', 'manual', 4, 481, '2026-08-03', '2026-08-03T00:00:00.000Z'),
-- MSFT (4 levels)
('MSFT', 'manual', 1, 431, '2026-08-03', '2026-08-03T00:00:00.000Z'),
('MSFT', 'manual', 2, 388, '2026-08-03', '2026-08-03T00:00:00.000Z'),
('MSFT', 'manual', 3, 367, '2026-08-03', '2026-08-03T00:00:00.000Z'),
('MSFT', 'manual', 4, 344, '2026-08-03', '2026-08-03T00:00:00.000Z'),
-- NFLX (3 levels)
('NFLX', 'manual', 1, 75, '2026-08-03', '2026-08-03T00:00:00.000Z'),
('NFLX', 'manual', 2, 68, '2026-08-03', '2026-08-03T00:00:00.000Z'),
('NFLX', 'manual', 3, 59, '2026-08-03', '2026-08-03T00:00:00.000Z'),
-- NOW (4 levels)
('NOW', 'manual', 1, 135, '2026-08-03', '2026-08-03T00:00:00.000Z'),
('NOW', 'manual', 2, 121, '2026-08-03', '2026-08-03T00:00:00.000Z'),
('NOW', 'manual', 3, 105, '2026-08-03', '2026-08-03T00:00:00.000Z'),
('NOW', 'manual', 4, 81, '2026-08-03', '2026-08-03T00:00:00.000Z'),
-- NVDA (4 levels)
('NVDA', 'manual', 1, 190, '2026-08-03', '2026-08-03T00:00:00.000Z'),
('NVDA', 'manual', 2, 153, '2026-08-03', '2026-08-03T00:00:00.000Z'),
('NVDA', 'manual', 3, 130, '2026-08-03', '2026-08-03T00:00:00.000Z'),
('NVDA', 'manual', 4, 91, '2026-08-03', '2026-08-03T00:00:00.000Z'),
-- NVO (4 levels)
('NVO', 'manual', 1, 68, '2026-08-03', '2026-08-03T00:00:00.000Z'),
('NVO', 'manual', 2, 57, '2026-08-03', '2026-08-03T00:00:00.000Z'),
('NVO', 'manual', 3, 46, '2026-08-03', '2026-08-03T00:00:00.000Z'),
('NVO', 'manual', 4, 35, '2026-08-03', '2026-08-03T00:00:00.000Z'),
-- PANW (3 levels)
('PANW', 'manual', 1, 198, '2026-08-03', '2026-08-03T00:00:00.000Z'),
('PANW', 'manual', 2, 166, '2026-08-03', '2026-08-03T00:00:00.000Z'),
('PANW', 'manual', 3, 142, '2026-08-03', '2026-08-03T00:00:00.000Z'),
-- PLTR (3 levels)
('PLTR', 'manual', 1, 142, '2026-08-03', '2026-08-03T00:00:00.000Z'),
('PLTR', 'manual', 2, 125.8, '2026-08-03', '2026-08-03T00:00:00.000Z'),
('PLTR', 'manual', 3, 105.2, '2026-08-03', '2026-08-03T00:00:00.000Z'),
-- UNH (3 levels)
('UNH', 'manual', 1, 409, '2026-08-03', '2026-08-03T00:00:00.000Z'),
('UNH', 'manual', 2, 385, '2026-08-03', '2026-08-03T00:00:00.000Z'),
('UNH', 'manual', 3, 357, '2026-08-03', '2026-08-03T00:00:00.000Z'),
-- V (3 levels)
('V', 'manual', 1, 326, '2026-08-03', '2026-08-03T00:00:00.000Z'),
('V', 'manual', 2, 308, '2026-08-03', '2026-08-03T00:00:00.000Z'),
('V', 'manual', 3, 292, '2026-08-03', '2026-08-03T00:00:00.000Z');
