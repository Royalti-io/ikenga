-- 0038_strategy_ext — WP-10a: strategy/exec domain tables missing from WP-02.
--
-- Down-mapped from LIVE Supabase introspection (2026-05-30). STRICT.
-- uuid/text id → TEXT, numeric (rice_*, alignment_score) → TEXT, integer →
-- INTEGER, jsonb (metadata, alignment_notes, discussion) → TEXT, text[]/uuid[]
-- (tags, affected_agents, spawned_task_ids, related_idea_ids) → TEXT
-- (JSON-encoded), Postgres enums (idea_status, idea_source) → TEXT, date /
-- timestamptz → TEXT. Cross-domain FKs (task_id, feature_id, initiative_id,
-- source_id) dropped; kept as TEXT soft links. `learnings.fts tsvector` OMITTED
-- (derived FTS vector — backfiller drops it).

CREATE TABLE IF NOT EXISTS architecture_decisions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  decision_date TEXT,
  owner TEXT,
  area TEXT,
  superseded_by TEXT,
  file_path TEXT,
  summary TEXT,
  tags TEXT,
  created_at TEXT,
  updated_at TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS learnings (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  body TEXT NOT NULL,
  source TEXT,
  source_agent TEXT,
  tags TEXT,
  severity TEXT,
  affected_agents TEXT,
  status TEXT,
  resolution_notes TEXT,
  resolution_date TEXT,
  resolution_commit TEXT,
  discovered_at TEXT,
  created_at TEXT,
  updated_at TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS ideas_backlog (
  id TEXT PRIMARY KEY,
  short_id TEXT NOT NULL,
  title TEXT NOT NULL,
  raw_content TEXT NOT NULL,
  summary TEXT,
  status TEXT NOT NULL,
  source TEXT NOT NULL,
  proposed_by TEXT NOT NULL,
  owner_agent TEXT,
  tags TEXT,
  category TEXT,
  priority TEXT,
  alignment_score TEXT,
  alignment_notes TEXT,
  initiative_id TEXT,
  spawned_task_ids TEXT,
  related_idea_ids TEXT,
  captured_at TEXT NOT NULL,
  validated_at TEXT,
  parked_at TEXT,
  killed_at TEXT,
  implemented_at TEXT,
  killed_reason TEXT,
  discussion TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS feature_score_history (
  id TEXT PRIMARY KEY,
  feature_id TEXT NOT NULL,
  score_date TEXT NOT NULL,
  rice_reach TEXT,
  rice_impact TEXT,
  rice_confidence INTEGER,
  rice_effort TEXT,
  rice_score TEXT,
  reason TEXT,
  created_at TEXT,
  updated_at TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS review_items (
  id TEXT PRIMARY KEY,
  content_type TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  source_table TEXT,
  source_id TEXT,
  file_path TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT,
  status TEXT,
  reviewed_at TEXT,
  review_notes TEXT,
  metadata TEXT,
  priority INTEGER,
  updated_at TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS task_approvals (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  approved_by TEXT,
  status TEXT,
  decision_notes TEXT,
  requested_at TEXT,
  decided_at TEXT,
  created_at TEXT,
  updated_at TEXT
) STRICT;
