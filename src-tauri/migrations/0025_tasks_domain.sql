-- 0025_tasks_domain — Atelier/PA "tasks / delegation / agents / home" domain.
--
-- Down-mapped from royalti-pa Supabase migrations (source of truth):
--   001_initial_schema.sql (tasks, delegations, agent_runs, notifications,
--                            calendar_events)
--   002_cfo_schema.sql:301-309 (tasks strategic-metadata ALTERs)
--   011, 014, 022, 050, 051 (further tasks / agent_runs ALTERs)
--   007_agent_handoffs.sql + 012 (agent_handoffs + retry ALTERs)
--   025_agent_reports.sql + 027 (agent_reports + session ALTERs)
--
-- Postgres → SQLite type down-map (STRICT tables; every column type is one of
-- INTEGER / REAL / TEXT / BLOB / ANY):
--   uuid/text/varchar/timestamptz/date/numeric → TEXT
--   jsonb / text[] (arrays)                     → TEXT (JSON-encoded)
--   boolean                                     → INTEGER (0/1)
--   int/bigint/serial                           → INTEGER
--   float/double                                → REAL
-- Cross-domain FK constraints (e.g. tasks.initiative_id → strategic_initiatives)
-- are intentionally DROPPED — SQLite can't forward-reference a table created in
-- a later migration, and the local store treats these as soft links. The
-- column is preserved (as TEXT); only the REFERENCES clause is dropped.

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'pending',
  priority TEXT DEFAULT 'medium',
  assigned_to TEXT,
  assignee_type TEXT DEFAULT 'human',
  created_by TEXT,
  agent_source TEXT,
  project_path TEXT,
  due_date TEXT,
  completed_at TEXT,
  created_at TEXT,
  updated_at TEXT,
  -- 011_task_email_link
  source_email_id TEXT,
  -- 014_task_execution_mode
  execution_mode TEXT DEFAULT 'report',
  task_result TEXT,
  last_checked_by TEXT,
  last_checked_at TEXT,
  -- 022_task_modified_by
  modified_by TEXT,
  -- 002_cfo_schema (strategic metadata)
  initiative_id TEXT,
  risk_id TEXT,
  category TEXT,
  tags TEXT,
  progress_pct INTEGER DEFAULT 0,
  effort_estimate TEXT,
  parent_task_id TEXT,
  blocked_by_task_id TEXT,
  outcome_notes TEXT,
  -- 051_tasks_claude_session
  claude_session_id TEXT,
  working_dir TEXT,
  last_activity_at TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS delegations (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  delegated_to TEXT NOT NULL,
  delegate_type TEXT DEFAULT 'human',
  status TEXT DEFAULT 'assigned',
  notes TEXT,
  assigned_at TEXT,
  completed_at TEXT,
  updated_at TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  agent_name TEXT NOT NULL,
  command TEXT,
  status TEXT DEFAULT 'running',
  output_summary TEXT,
  triggered_by TEXT DEFAULT 'cron',
  error_message TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT,
  -- 050_claude_sessions
  claude_session_id TEXT,
  working_dir TEXT,
  last_activity_at TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  message TEXT NOT NULL,
  task_id TEXT,
  sent_at TEXT,
  status TEXT DEFAULT 'sent',
  error_message TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS calendar_events (
  id TEXT PRIMARY KEY,
  google_event_id TEXT UNIQUE,
  title TEXT NOT NULL,
  description TEXT,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  location TEXT,
  reminder_sent INTEGER DEFAULT 0,
  source TEXT DEFAULT 'google_calendar',
  created_at TEXT,
  updated_at TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS agent_handoffs (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  request_type TEXT NOT NULL,
  domain TEXT NOT NULL,
  request_summary TEXT NOT NULL,
  urgency TEXT DEFAULT 'routine',
  context_email_ids TEXT,
  context_task_ids TEXT,
  context_files TEXT,
  expected_completion TEXT,
  status TEXT DEFAULT 'pending',
  result_summary TEXT,
  completion_time TEXT,
  created_at TEXT,
  updated_at TEXT,
  -- 012_handoff_retries
  retry_count INTEGER DEFAULT 0,
  max_retries INTEGER DEFAULT 3,
  last_retry_at TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS agent_reports (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  title TEXT NOT NULL,
  report_type TEXT NOT NULL DEFAULT 'status',
  domain TEXT NOT NULL,
  authored_by TEXT NOT NULL,
  summary TEXT,
  body TEXT,
  key_metrics TEXT,
  has_warnings INTEGER DEFAULT 0,
  has_critical INTEGER DEFAULT 0,
  alerts TEXT,
  duration_ms INTEGER,
  status TEXT DEFAULT 'published',
  created_at TEXT,
  updated_at TEXT,
  -- 027_report_session_id
  session_id TEXT,
  resume_command TEXT
) STRICT;
