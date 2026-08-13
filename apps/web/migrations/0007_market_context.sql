-- Market context has independent ownership from screening and earnings.
-- Rows are append-only observations; readers select the newest source row.
CREATE TABLE IF NOT EXISTS market_indices (
  symbol TEXT NOT NULL CHECK (symbol IN ('SPX', 'NDX', 'DJI', 'VIX')),
  name TEXT NOT NULL,
  value REAL NOT NULL CHECK (value > 0),
  change_pct REAL NOT NULL,
  source_timestamp TEXT NOT NULL,
  collected_at TEXT NOT NULL,
  provider TEXT NOT NULL,
  PRIMARY KEY (symbol, source_timestamp, provider)
);
CREATE INDEX IF NOT EXISTS idx_market_indices_latest
  ON market_indices (symbol, source_timestamp DESC);

CREATE TABLE IF NOT EXISTS market_sentiment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
  rating TEXT NOT NULL CHECK (rating IN ('extreme_fear', 'fear', 'neutral', 'greed', 'extreme_greed')),
  source_timestamp TEXT NOT NULL,
  collected_at TEXT NOT NULL,
  provider TEXT NOT NULL,
  UNIQUE (source_timestamp, provider)
);
CREATE INDEX IF NOT EXISTS idx_market_sentiment_latest
  ON market_sentiment (source_timestamp DESC);

-- Preserve any valid PR11 reading already written to app_meta during rollout.
INSERT OR IGNORE INTO market_sentiment (score, rating, source_timestamp, collected_at, provider)
SELECT
  CAST(json_extract(value, '$.score') AS INTEGER),
  json_extract(value, '$.rating'),
  datetime(json_extract(value, '$.asOf')) || 'Z',
  datetime(json_extract(value, '$.asOf')) || 'Z',
  json_extract(value, '$.provider')
FROM app_meta
WHERE key = 'sentiment'
  AND json_extract(value, '$.score') BETWEEN 0 AND 100
  AND json_extract(value, '$.rating') IN ('extreme_fear', 'fear', 'neutral', 'greed', 'extreme_greed')
  AND json_extract(value, '$.asOf') IS NOT NULL
  AND json_extract(value, '$.provider') IS NOT NULL;

-- Backfill index rows from the legacy snapshot when it contains PR11 data.
INSERT OR IGNORE INTO market_indices
  (symbol, name, value, change_pct, source_timestamp, collected_at, provider)
SELECT
  json_extract(index_row.value, '$.symbol'),
  json_extract(index_row.value, '$.name'),
  json_extract(index_row.value, '$.value'),
  json_extract(index_row.value, '$.change'),
  json_extract(index_row.value, '$.updatedAt'),
  COALESCE(json_extract(snapshot.value, '$.updatedAt'), json_extract(index_row.value, '$.updatedAt')),
  COALESCE(json_extract(snapshot.value, '$.provider'), 'legacy-market-context')
FROM app_meta AS snapshot, json_each(json_extract(snapshot.value, '$.indices')) AS index_row
WHERE snapshot.key = 'marketData'
  AND json_extract(index_row.value, '$.symbol') IN ('SPX', 'NDX', 'DJI', 'VIX')
  AND json_extract(index_row.value, '$.value') > 0
  AND json_extract(index_row.value, '$.updatedAt') IS NOT NULL;
