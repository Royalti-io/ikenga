-- 0060_drop_chat_sessions.sql
-- WP-06 of plans/2026-08-08-ikenga-chi-first: remove the legacy chat session
-- tables. Agent records (Claude JSONL, Devin sidecar ledger, chi_cache) are
-- the source of truth going forward. No data migration is performed; existing
-- chat_sessions rows are dropped.

-- SQLite drops a table's indexes with the table, so the explicit DROP INDEX
-- statements come first purely so a partially-applied earlier attempt (index
-- present, table already gone) still converges.
DROP INDEX IF EXISTS idx_chat_sessions_engine_id;
DROP INDEX IF EXISTS idx_chat_user_turns_thread;
DROP TABLE IF EXISTS chat_user_turns;
DROP TABLE IF EXISTS chat_sessions;
