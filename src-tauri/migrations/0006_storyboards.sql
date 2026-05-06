-- Phase 7: storyboard editor.
-- SQLite is authoritative for storyboard data; export to compositions/{slug}/storyboard.json
-- is a manual hook for the legacy engine CLI during the dogfood window.
--
-- Three tables:
--   storyboards         — top-level metadata + Rung pointer
--   storyboard_beats    — per-beat data with rungs flattened to columns
--   storyboard_jobs     — long-running ops (render-still, promote-rung); mirrors render_jobs

CREATE TABLE storyboards (
  id                     TEXT PRIMARY KEY,                 -- slug; matches engine compositions/{slug}/
  title                  TEXT NOT NULL,
  blog_post_id           TEXT,
  source_kind            TEXT,                             -- 'blog' | 'markdown' | 'blank' | 'imported'
  source_ref             TEXT,
  current_rung           INTEGER NOT NULL DEFAULT 0,       -- 0 | 1 | 2
  composition_id         TEXT,                             -- nullable until Rung 1 scaffolded
  narration              TEXT,                             -- JSON: { audio, words[] } or NULL
  selected_concepts      TEXT,                             -- JSON array; NULL if none
  selected_concepts_note TEXT,
  exported_at            INTEGER,                          -- last filesystem export (ms)
  version                INTEGER NOT NULL DEFAULT 1,       -- optimistic-lock counter
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL
);

CREATE INDEX idx_storyboards_updated_at ON storyboards(updated_at DESC);

CREATE TABLE storyboard_beats (
  id                TEXT NOT NULL,                         -- beat id (stable across rungs)
  storyboard_id     TEXT NOT NULL REFERENCES storyboards(id) ON DELETE CASCADE,
  index_in_board    INTEGER NOT NULL,
  label             TEXT NOT NULL,
  time_start        REAL NOT NULL,                         -- seconds
  time_end          REAL NOT NULL,
  frame_start       INTEGER NOT NULL,
  frame_end         INTEGER NOT NULL,
  narration_excerpt TEXT,
  intent            TEXT,
  -- Rungs flattened: 0_beat_sheet (r0), 1_lofi (r1), 2_hifi (r2).
  -- Rung set is finite, so columns beat a JOIN.
  r0_status         TEXT NOT NULL DEFAULT 'pending',
  r0_content        TEXT,
  r1_status         TEXT NOT NULL DEFAULT 'pending',
  r1_still_path     TEXT,
  r1_tsx_anchor     TEXT,
  r2_status         TEXT NOT NULL DEFAULT 'pending',
  r2_still_path     TEXT,
  comments          TEXT NOT NULL DEFAULT '[]',            -- JSON array; append-only, low cardinality
  PRIMARY KEY (storyboard_id, id)
);

CREATE INDEX idx_storyboard_beats_order ON storyboard_beats(storyboard_id, index_in_board);

CREATE TABLE storyboard_jobs (
  id              TEXT PRIMARY KEY,
  storyboard_id   TEXT NOT NULL,                           -- not FK; jobs survive storyboard deletes
  kind            TEXT NOT NULL,                           -- 'render_still' | 'promote_rung' | 'regenerate_beat'
  beat_id         TEXT,                                    -- NULL for whole-rung ops
  target_rung     INTEGER,
  status          TEXT NOT NULL,                           -- queued | running | complete | failed | cancelled
  progress        REAL NOT NULL DEFAULT 0,                 -- 0..1
  log             TEXT NOT NULL DEFAULT '',                -- stdout/stderr tail (4KB cap)
  error           TEXT,
  started_at      INTEGER,
  completed_at    INTEGER,
  created_at      INTEGER NOT NULL
);

CREATE INDEX idx_storyboard_jobs_storyboard ON storyboard_jobs(storyboard_id, created_at DESC);
CREATE INDEX idx_storyboard_jobs_status ON storyboard_jobs(status);
