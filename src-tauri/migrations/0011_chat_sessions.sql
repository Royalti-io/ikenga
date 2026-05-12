-- 0011_chat_sessions.sql
-- Session-as-object: a chat thread owns an optional streaming child + optional
-- PTY. The thread id is a stable internal uuid we mint frontend-side; Claude's
-- session id and the PTY id are attributes.
--
-- New table:
--   * chat_user_turns — what the user typed (Claude's JSONL only records
--     assistant turns and tool-result-shaped user envelopes, so we need our
--     own record to render the user side of the conversation across reloads).
--
-- Phase 11 (2026-05-11) audited and KEPT this table. ACP's
-- `user_message_chunk` is not emitted by our `AcpServer` for our own writes
-- (only agent-side events forward back), and `stream_parser.rs::dispatch_user`
-- drops plain-string user messages from claude's JSONL. So this table is the
-- only durable record of user input. See `shell/docs/acp-migration.md` § Phase 11.
--
-- Schema for chat_threads predates this — see 0001_init.sql + 0003_claude_sessions.sql.

CREATE TABLE IF NOT EXISTS chat_user_turns (
  id          TEXT PRIMARY KEY,
  thread_id   TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  text        TEXT NOT NULL,
  sequence    INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_user_turns_thread
  ON chat_user_turns(thread_id, sequence);
