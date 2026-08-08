-- 0060_drop_chat_sessions.sql
-- WP-06 of plans/2026-08-08-ikenga-chi-first: remove the legacy chat session
-- tables. Agent records (Claude JSONL, Devin sidecar ledger, chi_cache) are
-- the source of truth going forward. No data migration is performed; existing
-- chat_sessions rows are dropped.

DROP TABLE IF EXISTS chat_user_turns;
DROP TABLE IF EXISTS chat_sessions;
DROP INDEX IF EXISTS idx_chat_sessions_engine_id;
