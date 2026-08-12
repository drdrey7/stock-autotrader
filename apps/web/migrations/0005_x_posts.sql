-- 0005_x_posts.sql — X posts read model (PR #8, X Search feed)
-- Additive migration. Stores collected X posts for the public X Search feed.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS x_posts (
  id TEXT PRIMARY KEY,
  author TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  url TEXT NOT NULL,
  symbol TEXT,
  company TEXT,
  universe TEXT,
  collected_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_x_posts_created ON x_posts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_x_posts_author ON x_posts(author, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_x_posts_symbol ON x_posts(symbol) WHERE symbol IS NOT NULL;
