-- 0037_content_ext — WP-10a: content domain table missing from WP-02.
--
-- Down-mapped from LIVE Supabase introspection (2026-05-30). STRICT.
-- text[] (source_urls, tags) → TEXT (JSON-encoded), integer → INTEGER,
-- timestamptz → TEXT. The Postgres `fts tsvector` search-vector column is
-- OMITTED — it is a derived FTS index with no local value (the WP-10b
-- backfiller drops it intentionally, same class as tasks.updated_by).

CREATE TABLE IF NOT EXISTS research_notes (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_name TEXT NOT NULL,
  entity_id TEXT,
  title TEXT NOT NULL,
  summary TEXT,
  body TEXT NOT NULL,
  source_urls TEXT,
  research_depth TEXT,
  tags TEXT,
  fit_score INTEGER,
  fit_notes TEXT,
  status TEXT,
  researched_by TEXT,
  created_at TEXT,
  updated_at TEXT
) STRICT;
