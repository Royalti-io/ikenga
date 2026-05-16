-- 0023_studio_threads.sql
-- Chat threads for the unified artifact-studio pane (see
-- plans/shell/2026-05-16-artifact-studio-unified.md §"Chat thread model (D3)").
--
-- One thread per folder. The "scope chip" the user is operating under
-- (folder · artifact · element · compare) travels with each message in the
-- `scope_chip_json` column, so the thread visibly re-scopes as the user
-- focuses without forking the conversation.
--
-- This is intentionally NOT keyed on (folder, artifact) — D3 collapses those
-- into one thread. The scope chip is metadata, not a partition key.
--
--   folder_path     — workspace-relative or absolute path to the folder
--                     opened in Studio. Same key the grid density / loupe
--                     route resolver uses.
--   created_at /
--   last_message_at — unix millis. `last_message_at` is bumped on every
--                     `studio_message_append` so the "recently active
--                     threads" list is a cheap sort.

CREATE TABLE IF NOT EXISTS studio_threads (
  id                TEXT    PRIMARY KEY,                 -- uuid v4
  folder_path       TEXT    NOT NULL UNIQUE,
  created_at        INTEGER NOT NULL,
  last_message_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_studio_threads_recent
  ON studio_threads(last_message_at DESC);

-- One row per message. `role` matches the chat conventions used elsewhere in
-- the shell (`user` / `claude` / `tool`). `content_md` is the message body
-- (markdown in v0); tool calls / outputs serialize into `content_md` too,
-- with `role = 'tool'` so the renderer can style them distinctly.
--
-- `scope_chip_json` is the scope under which the message was sent or received.
-- Shape (validated client-side):
--   { "kind": "folder",   "target": "./marketing-q2/" }
--   { "kind": "artifact", "target": "cfo-daily.html" }
--   { "kind": "element",  "target": "cfo-daily.html#cash-chart",
--     "selector": "#cash-chart", "pinId": 42 }
--   { "kind": "compare",  "target": "cfo-daily.html ↔ v3-dark.html",
--     "left": "cfo-daily.html", "right": "cfo-daily-v3-dark.html" }
--
-- Storing as JSON (not normalized columns) so future scope kinds don't need
-- a migration. The renderer parses + falls back gracefully on unknown kinds.

CREATE TABLE IF NOT EXISTS studio_messages (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id         TEXT    NOT NULL
                      REFERENCES studio_threads(id) ON DELETE CASCADE,
  role              TEXT    NOT NULL
                      CHECK (role IN ('user', 'claude', 'tool')),
  content_md        TEXT    NOT NULL,
  scope_chip_json   TEXT,                                 -- nullable for tool turns
  created_at        INTEGER NOT NULL
);

-- The hot read path is "show me the last N messages of this thread".
CREATE INDEX IF NOT EXISTS idx_studio_messages_thread_created
  ON studio_messages(thread_id, created_at);
