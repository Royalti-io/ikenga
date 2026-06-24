-- 0055_chrome_profiles.sql
-- WP-03 — Managed Chrome dedicated-profile registry.
--
-- A "managed profile" is a dedicated --user-data-dir Chrome was launched with
-- by the Ikenga shell. The on-disk dir (see app_data_dir/chrome-profiles/<name>/)
-- is owned by chrome/profile.rs; this table is a registry that lets the
-- lifecycle layer (WP-04) and future MCP tooling resolve friendly names to
-- stable on-disk paths without re-deriving the sanitized name.
--
-- Deleting a row here does NOT delete the on-disk profile data — a future
-- launch_managed with the same name picks the Chrome logins and cookies back
-- up. That mirrors how browser_sessions (0014) handles WebKit partitions.

CREATE TABLE IF NOT EXISTS chrome_profiles (
  name          TEXT PRIMARY KEY,       -- caller-supplied profile name (sanitized)
  dir           TEXT NOT NULL,          -- absolute path to the --user-data-dir on disk
  created_at    INTEGER NOT NULL,       -- unix ms
  last_used_at  INTEGER                 -- unix ms; updated on each launch_managed call
);

CREATE INDEX IF NOT EXISTS idx_chrome_profiles_last_used ON chrome_profiles(last_used_at DESC);
