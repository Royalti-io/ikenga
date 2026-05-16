-- 0022_artifact_comments.sql
-- Pin-mode comments on artifacts (artifact-grid v0 — see
-- plans/shell/2026-05-16-artifact-grid-brainstorm.md).
--
-- A pin is a structured note anchored to a CSS selector inside a rendered
-- artifact. On creation it is `open`; the agent transitions it to
-- `in_progress` (via `mcp-iyke.pin_acknowledge`) when it starts working, and
-- to `resolved` either manually by the user or via `mcp-iyke.pin_resolve`.
--
--   artifact_path        — absolute or workspace-relative path to the .html
--                          file the pin is attached to. Same key the
--                          viewer-server / html-frame.tsx uses for routing.
--   selector             — a CSS selector resolved inside the artifact's
--                          iframe at creation time. May go stale if the
--                          artifact's DOM changes (status moves to `stale`).
--   text                 — the comment body (plain text in v0; markdown later).
--   screenshot_path      — local file path to a captured PNG of the targeted
--                          element. NULL when capture was skipped.
--   status               — open | in_progress | resolved | stale.
--   position_x/_y        — normalized 0..1 coordinates of the targeted element
--                          inside the iframe at creation time. Used to
--                          render the pin on the grid thumbnail at low cost
--                          without re-resolving the selector every render.
--   thread_id            — id of the side-pane Chat thread that owns the
--                          conversation, when the chat sink was used. NULL
--                          when the terminal sink handled it.
--   opening_session_id   — claude session id of the PTY at routing time, when
--                          the terminal sink was used. Captured for the
--                          audit trail; not used for any current routing.
--   sink                 — terminal | sidepane | both. Audit field.
--   created_at /
--   acknowledged_at /
--   resolved_at          — unix millis. NULL until the corresponding
--                          transition. `acknowledged_at` is set on the
--                          first open→in_progress transition (idempotent
--                          on later re-acks).

CREATE TABLE IF NOT EXISTS artifact_comments (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  artifact_path        TEXT    NOT NULL,
  selector             TEXT    NOT NULL,
  text                 TEXT    NOT NULL,
  screenshot_path      TEXT,
  status               TEXT    NOT NULL DEFAULT 'open'
                         CHECK (status IN ('open', 'in_progress', 'resolved', 'stale')),
  position_x           REAL,
  position_y           REAL,
  thread_id            TEXT,
  opening_session_id   TEXT,
  sink                 TEXT
                         CHECK (sink IS NULL OR sink IN ('terminal', 'sidepane', 'both')),
  created_at           INTEGER NOT NULL,
  acknowledged_at      INTEGER,
  resolved_at          INTEGER
);

-- Open pins per artifact is the hot read path — the grid cell pulls the
-- non-resolved pins for every visible cell on every render.
CREATE INDEX IF NOT EXISTS idx_artifact_comments_path_status
  ON artifact_comments(artifact_path, status);

-- Cross-folder inbox view (board-level "all open pins") sorts by recency.
CREATE INDEX IF NOT EXISTS idx_artifact_comments_status_created
  ON artifact_comments(status, created_at DESC);
