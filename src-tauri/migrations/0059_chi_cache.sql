-- 0059_chi_cache.sql
-- Thin local cache for the Chi-first agent surface. Agent records are the
-- source of truth; this table maps Ikenga run_ids to engine-native ids and
-- stores one-off run output metadata.

CREATE TABLE IF NOT EXISTS chi_cache (
  run_id TEXT PRIMARY KEY,
  engine_id TEXT NOT NULL,
  external_id TEXT,
  brief TEXT,
  cwd TEXT,
  model TEXT,
  mode TEXT,
  status TEXT,
  output_path TEXT,
  output_truncated BOOLEAN,
  error TEXT,
  artifacts TEXT,
  parent_id TEXT,
  owner TEXT NOT NULL,
  terminal_session_id TEXT,
  started_at TEXT,
  ended_at TEXT,
  last_seen_at TEXT,
  expires_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_chi_cache_engine_last_seen
  ON chi_cache(engine_id, last_seen_at);

CREATE INDEX IF NOT EXISTS idx_chi_cache_external_id
  ON chi_cache(engine_id, external_id);
