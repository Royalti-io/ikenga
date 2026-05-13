-- Phase 4 (pkg-browser): named-session metadata.
--
-- A "session" is a human-friendly handle for a cookie/storage partition
-- in a pkg's webview capability. The on-disk partition (see
-- `app_data_dir/webjars/<pkg-slug>/<partition>/`) is owned by the
-- kernel; this table is just a registry that lets the MCP / FE resolve
-- friendly names (e.g. "spotify-main") to partition slugs (e.g.
-- "spotify-2026-01").
--
-- Deleting a row here does NOT delete the on-disk partition data — a
-- future `session_create` with the same partition slug picks the
-- cookies back up. That's intentional (matches how browser profile
-- managers work).

CREATE TABLE browser_sessions (
  pkg_id        TEXT NOT NULL,
  name          TEXT NOT NULL,
  partition     TEXT NOT NULL,
  created_at    INTEGER NOT NULL,                  -- unix ms
  last_used_at  INTEGER,                           -- unix ms; updated on browser_open
  PRIMARY KEY (pkg_id, name)
);

CREATE INDEX idx_browser_sessions_last_used ON browser_sessions(pkg_id, last_used_at DESC);
