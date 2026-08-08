-- 0061_drop_chat_messages.sql
-- WP-06 follow-up: remove the legacy `chat_messages` table that predates
-- 0011_chat_sessions.sql and was never referenced by the retired chat surface.

DROP INDEX IF EXISTS idx_chat_messages_thread;
DROP TABLE IF EXISTS chat_messages;
