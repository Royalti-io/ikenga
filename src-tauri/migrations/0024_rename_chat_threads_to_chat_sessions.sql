-- 0024_rename_chat_threads_to_chat_sessions.sql
-- ADR-013 §2 — rename `chat_threads` to `chat_sessions` and add an
-- `engine_id` discriminator so multiple engine adapters (claude-code,
-- future codex, gemini, etc.) can coexist on the same row schema.
--
-- Why the rename:
--   Pre-ADR-013 the table was named `chat_threads` because every row was
--   a Claude conversation. With multi-engine support we no longer want
--   the schema to leak that history — the row is a generic "engine
--   session", and the engine in question is now data, not table identity.
--
-- Why `engine_id` defaults to 'claude-code':
--   Every existing row was created by the (then-only) claude-code adapter.
--   The DEFAULT backfills those rows in-place during the ALTER; new rows
--   inserted post-migration MUST set engine_id explicitly (the column is
--   NOT NULL, the DEFAULT only fires when the column is omitted from the
--   INSERT). The server-side INSERT in
--   `engines/claude_code/server.rs::handle_fork_session` is updated in
--   this commit to write the literal 'claude-code' for clarity.
--
-- Why we don't rename the pre-existing `idx_chat_threads_*` indexes:
--   SQLite preserves indexes across `ALTER TABLE … RENAME TO` — they keep
--   working on the renamed table under their old names. Cascading the
--   rename to the index names is pure churn with no behavioral payoff
--   (the names are an implementation detail not exposed to the FE) and
--   would force every consumer of `sqlite_master` to learn the new names.
--   A future ADR can clean them up if we ever need to; ADR-013 explicitly
--   scopes this migration to "rename the table, add the column".
--
-- Why we don't rename the `claude_session_id` column:
--   Same reasoning. Its meaning is now "engine-native resume id" — for
--   `engine_id='claude-code'` it's the claude CLI session id, for a
--   future codex adapter it'd be whatever resume token codex returns.
--   engine_id disambiguates the semantics row-by-row, so the column
--   name carrying its first interpretation is fine. A future cleanup
--   ADR could rename to `engine_session_id`; we are not doing that here.

ALTER TABLE chat_threads RENAME TO chat_sessions;
ALTER TABLE chat_sessions ADD COLUMN engine_id TEXT NOT NULL DEFAULT 'claude-code';
CREATE INDEX idx_chat_sessions_engine_id ON chat_sessions(engine_id);
