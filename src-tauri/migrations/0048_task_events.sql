-- 0048_task_events.sql — task activity/audit log (B.4 of the 2026-06-07 atelier
-- design-vs-impl review). Gives the task detail Activity timeline a real history
-- to render, replacing the "deferred · audit table" placeholder.
--
-- No SQLite triggers: the shell migration runner (commands/db.rs
-- split_statements) splits on every `;` outside string literals and does NOT
-- support trigger bodies. The table is populated by (a) this one-time backfill
-- from existing tasks columns and (b) future app-level writes (UPSERT) when a
-- mutation path lands. The detail pane also derives created/completed from the
-- task row itself as a fallback, so the timeline is always real even for tasks
-- with no recorded event yet.
--
-- Soft TEXT link to tasks.id (no FK, matching the 0025 tasks domain convention).

CREATE TABLE IF NOT EXISTS task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  from_value TEXT,
  to_value TEXT,
  actor TEXT,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events (task_id, created_at);

-- Backfill: created event for every task (real created_at + author).
INSERT INTO task_events (task_id, event_type, to_value, actor, created_at)
SELECT id, 'created', status, COALESCE(created_by, agent_source), created_at
FROM tasks
WHERE created_at IS NOT NULL AND created_at != '';

-- Backfill: completed event for every finished task (real completed_at + actor).
INSERT INTO task_events (task_id, event_type, to_value, actor, created_at)
SELECT id, 'completed', 'completed', COALESCE(modified_by, assigned_to, agent_source, 'system'), completed_at
FROM tasks
WHERE completed_at IS NOT NULL AND completed_at != '';

-- Backfill: agent-checked event where an audit stamp exists and is distinct from
-- the create/complete moments (so we don't duplicate those rows).
INSERT INTO task_events (task_id, event_type, actor, created_at)
SELECT id, 'checked', last_checked_by, last_checked_at
FROM tasks
WHERE last_checked_at IS NOT NULL AND last_checked_at != ''
  AND last_checked_at != COALESCE(completed_at, '')
  AND last_checked_at != COALESCE(created_at, '');
