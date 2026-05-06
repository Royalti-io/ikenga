-- Phase 3: Claude Code session integration.
-- Augments chat_threads so a thread can be bound to a Claude Code session
-- (the on-disk uuid + cwd). pty_id is live-only — cleared on app restart so
-- stale handles don't leak into a fresh launch.

ALTER TABLE chat_threads ADD COLUMN claude_session_id TEXT;
ALTER TABLE chat_threads ADD COLUMN project_dir TEXT;
ALTER TABLE chat_threads ADD COLUMN pty_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_threads_claude_session
  ON chat_threads(claude_session_id)
  WHERE claude_session_id IS NOT NULL;
