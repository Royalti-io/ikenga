-- 0039_infra_ext — WP-10a: misc/infra domain tables missing from WP-02.
--
-- Down-mapped from LIVE Supabase introspection (2026-05-30). STRICT.
-- uuid/text id → TEXT, integer → INTEGER, numeric (duration_sec,
-- total_cost_usd) → TEXT, jsonb (metadata) → TEXT, timestamptz → TEXT.
--
-- NOTE on `claude_sessions`: this is royalti-pa's agent-session tracker
-- (session_id / mm_channel_id / tmux_session / agent_type / working_directory),
-- a DIFFERENT object from the shell's chat-session machinery. Shell migration
-- 0003_claude_sessions only ALTERs chat_threads — it never created a
-- `claude_sessions` base table, so there is no name collision.
--
-- `pa_actions_cursor` has a COMPOSITE primary key (job_id, key) in live.

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT,
  organization TEXT,
  stripe_customer_id TEXT,
  notion_page_id TEXT,
  research_path TEXT,
  contact_type TEXT,
  last_seen_at TEXT,
  interaction_count INTEGER,
  notes TEXT,
  created_at TEXT,
  updated_at TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS claude_sessions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  mm_channel_id TEXT,
  mm_thread_post_id TEXT,
  tmux_session TEXT,
  tmux_window TEXT,
  agent_type TEXT,
  working_directory TEXT,
  status TEXT,
  started_at TEXT,
  last_activity_at TEXT,
  ended_at TEXT,
  created_at TEXT,
  updated_at TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS pa_actions_cursor (
  job_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (job_id, key)
) STRICT;

CREATE TABLE IF NOT EXISTS video_projects (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  script_path TEXT,
  status TEXT NOT NULL,
  style TEXT,
  resolution TEXT NOT NULL,
  fps INTEGER NOT NULL,
  duration_sec TEXT,
  scene_count INTEGER,
  total_cost_usd TEXT,
  video_provider TEXT NOT NULL,
  rendered_path TEXT,
  published_url TEXT,
  error TEXT,
  source TEXT NOT NULL,
  created_by TEXT NOT NULL,
  metadata TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
