-- Recently-opened artifacts. Written from the FE on every <ArtifactView>
-- mount; consumed by the ⌘O command palette and inbox "Recent files" widget
-- (consumer UIs are spec-future; the writes land here so we don't have to
-- backfill).
CREATE TABLE IF NOT EXISTS viewer_recents (
  path        TEXT PRIMARY KEY,
  mime        TEXT,
  last_opened INTEGER NOT NULL,
  source      TEXT
);

CREATE INDEX IF NOT EXISTS idx_viewer_recents_last_opened
  ON viewer_recents(last_opened DESC);
