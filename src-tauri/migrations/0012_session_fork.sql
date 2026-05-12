-- 0012_session_fork.sql
-- Phase 8: session fork tracking. When a user clicks "Branch from here"
-- on an assistant turn, we create a new chat_threads row whose
-- `branched_from` points at the source thread. `branched_from_turn`
-- records the cutoff turn index so we know where the transcript copy
-- ends. Phase 8 minimum implementation: we only persist the
-- relationship — the new session resumes claude with the source's
-- `claude_session_id` so the on-disk JSONL transcript seeds the new
-- thread's first turn (`--resume <source_session_id>` is set on the
-- forked session's `SessionOpts.resume_session_id` at fork time). A
-- future phase can do a real transcript copy if we need true
-- divergence at the JSONL level.
--
-- `chat_threads` predates this migration — see 0001_init.sql for the
-- original schema, 0003_claude_sessions.sql for the claude session
-- columns.

ALTER TABLE chat_threads ADD COLUMN branched_from TEXT REFERENCES chat_threads(id);
ALTER TABLE chat_threads ADD COLUMN branched_from_turn INTEGER;

CREATE INDEX IF NOT EXISTS idx_chat_threads_branched_from
  ON chat_threads(branched_from);
