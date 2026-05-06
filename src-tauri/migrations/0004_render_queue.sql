-- Phase 6 day 4: render queue persistence.
-- Tracks Remotion render jobs across app restarts. The frontend writes
-- through tauri-plugin-sql; useRender persists each lifecycle event.
--
-- A row is created at status='queued' before the Tauri command resolves.
-- Status flows: queued → running → (complete | failed | cancelled).
-- Failed/complete/cancelled rows are kept until the user dismisses them.

CREATE TABLE render_jobs (
  id              TEXT PRIMARY KEY,
  composition_id  TEXT NOT NULL,
  props           TEXT NOT NULL,        -- JSON
  output_path     TEXT NOT NULL,
  status          TEXT NOT NULL,        -- queued | running | complete | failed | cancelled
  progress        REAL NOT NULL DEFAULT 0,  -- 0..1
  started_at      INTEGER,              -- ms since epoch, NULL until process spawned
  completed_at    INTEGER,
  error           TEXT,
  created_at      INTEGER NOT NULL      -- ms since epoch
);

CREATE INDEX idx_render_jobs_status ON render_jobs(status);
CREATE INDEX idx_render_jobs_created_at ON render_jobs(created_at DESC);
