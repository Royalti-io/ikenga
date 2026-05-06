-- Last-sync state for the mbox sidecar poller. Single-row key/value table —
-- the schema is intentionally generic so future poller-style features (sent
-- mailbox scan, attachment cache invalidation, etc.) can reuse it without a
-- new migration.
CREATE TABLE IF NOT EXISTS mbox_sync_state (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);
