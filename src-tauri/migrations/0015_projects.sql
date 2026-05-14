-- 0015_projects.sql
-- Projects-first-class foundation. A project is a user-named context
-- (working dir + display name + scoped state) that hangs together chats,
-- pkgs, layout, and (in later phases) memory primitives, env, secrets.
--
-- Phase 0 of the projects-first-class plan
-- (.company/technical/plans/2026-05-12-projects-first-class/).
--
-- The 'default' project is bootstrapped at startup (commands/db.rs) so
-- this migration is purely DDL — Rust code seeds Default once.
--
-- The plan calls for `project_id` columns on chat_threads, pkg_installed,
-- layout_state, and browser_sessions; we add them here, nullable. The
-- Default-project bootstrap step backfills NULLs to 'default' so the
-- columns can later be treated as required by app-layer logic.

CREATE TABLE IF NOT EXISTS projects (
  id            TEXT PRIMARY KEY,                  -- slug, e.g. 'default', 'music-2026'
  display_name  TEXT NOT NULL,
  root_path     TEXT,                              -- working dir; nullable for skill-only projects
  icon          TEXT,                              -- emoji or path
  color         TEXT,                              -- hex (#RRGGBB) for activity-bar dot
  description   TEXT,
  position      INTEGER NOT NULL DEFAULT 0,        -- user-controlled order in the switcher
  is_default    INTEGER NOT NULL DEFAULT 0,        -- exactly one row has this set
  created_at    INTEGER NOT NULL,                  -- unix ms
  archived_at   INTEGER                            -- unix ms; NULL = active
);

-- One default project, enforced at the DB layer.
CREATE UNIQUE INDEX IF NOT EXISTS projects_default
  ON projects (is_default) WHERE is_default = 1;

CREATE INDEX IF NOT EXISTS projects_active
  ON projects (archived_at);

-- Per-project KV bag for config that isn't worth its own column.
CREATE TABLE IF NOT EXISTS project_settings (
  project_id  TEXT NOT NULL,
  key         TEXT NOT NULL,
  value       TEXT NOT NULL,                       -- JSON
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (project_id, key),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- ── project_id columns on existing tables ────────────────────────────────
-- These columns are added nullable to land cleanly on existing dbs. The
-- bootstrap step in commands/db.rs (run after migrations) backfills NULLs
-- to 'default' and ensures the default project row exists.
--
-- ON DELETE SET NULL on chat_threads, pkg_installed, layout_state because
-- archiving a project should keep its rows queryable; browser_sessions
-- gets the same treatment.
--
-- The migration runner swallows "duplicate column name" so re-runs on a
-- dev db with the column already present are safe.

ALTER TABLE chat_threads     ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;
ALTER TABLE pkg_installed    ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;
ALTER TABLE layout_state     ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;
ALTER TABLE browser_sessions ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_chat_threads_project     ON chat_threads(project_id);
CREATE INDEX IF NOT EXISTS idx_pkg_installed_project    ON pkg_installed(project_id);
CREATE INDEX IF NOT EXISTS idx_layout_state_project     ON layout_state(project_id);
CREATE INDEX IF NOT EXISTS idx_browser_sessions_project ON browser_sessions(project_id);
