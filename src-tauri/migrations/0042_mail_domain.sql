-- 0042_mail_domain — WP-17b: mail thread-state table.
--
-- Creates `mail_thread_state` — the per-message read/unread, snooze, tags,
-- and preview state that the mail pkg needs for its Inbox / Triage sidebar
-- counts and list-row rendering.
--
-- Design decisions:
--   * NO FK constraints (soft TEXT link to email_messages.id — per the
--     0025–0031 convention; all cross-table links are TEXT soft keys).
--   * STRICT — all column types enforced at the SQLite level.
--   * is_read INTEGER (0/1 boolean) — SQLite has no BOOLEAN type; 0=unread.
--   * snoozed_until TEXT — ISO-8601 datetime string; NULL = not snoozed.
--   * tags TEXT — JSON array string (e.g. '["deal","warn"]'); NULL = no tags.
--   * preview TEXT — pre-computed 120-char excerpt for list rendering; NULL
--     lets the pkg fall back to substr(email_messages.body_text, 1, 120).
--
-- The mail pkg upserts rows here on mark-read, snooze, and tag operations
-- (INSERT … ON CONFLICT DO UPDATE). Reads JOIN email_messages LEFT JOIN
-- mail_thread_state ON mts.message_id = em.id.
--
-- This table is owned by WP-17b. Declared in 08-pkg-retrofit-recipe.md
-- §Schema-TBD as the "thread-state table" for the mail domain.

CREATE TABLE IF NOT EXISTS mail_thread_state (
  message_id   TEXT PRIMARY KEY,
  is_read      INTEGER NOT NULL DEFAULT 0,
  snoozed_until TEXT,
  tags         TEXT,
  preview      TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
) STRICT;
