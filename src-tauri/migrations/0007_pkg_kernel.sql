-- 0007_pkg_kernel.sql
-- Composable-app kernel: every feature (built-in or installed) is a package
-- with a manifest, declared capability blocks, and lifecycle-managed
-- registrations against in-process registries. Tables here persist install
-- state across launches so the kernel can replay registrations at boot.
--
-- See `src-tauri/src/pkg/` for the runtime side.

CREATE TABLE IF NOT EXISTS pkg_installed (
  id              TEXT PRIMARY KEY,            -- reverse-DNS, e.g. com.royalti.fundraising
  version         TEXT NOT NULL,
  ikenga_api      TEXT NOT NULL,               -- manifest's host-API contract version
  manifest_json   TEXT NOT NULL,               -- raw manifest, for re-registration on boot
  install_path    TEXT NOT NULL,               -- absolute path to the unpacked package dir
  installed_at    INTEGER NOT NULL,            -- unix ms
  enabled         INTEGER NOT NULL DEFAULT 1,  -- 0 = disabled but not uninstalled
  signature       TEXT                          -- ed25519 sig of manifest, nullable for personal/dev
);

CREATE INDEX IF NOT EXISTS idx_pkg_installed_enabled ON pkg_installed(enabled);

-- Per-package settings keyed by manifest's settings_schema. Values are JSON
-- so the same table covers strings, numbers, booleans, objects.
CREATE TABLE IF NOT EXISTS pkg_settings (
  pkg_id      TEXT NOT NULL,
  key         TEXT NOT NULL,
  value_json  TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (pkg_id, key),
  FOREIGN KEY (pkg_id) REFERENCES pkg_installed(id) ON DELETE CASCADE
);

-- Track which package-namespaced SQL migrations have been applied, mirroring
-- the host's tauri-plugin-sql migration model but scoped per package so
-- packages can ship their own schema without colliding.
CREATE TABLE IF NOT EXISTS pkg_migrations (
  pkg_id      TEXT NOT NULL,
  n           INTEGER NOT NULL,
  name        TEXT NOT NULL,
  applied_at  INTEGER NOT NULL,
  PRIMARY KEY (pkg_id, n),
  FOREIGN KEY (pkg_id) REFERENCES pkg_installed(id) ON DELETE CASCADE
);

-- User-granted permission scopes. The manifest *declares* what a package
-- needs; this table records what the user has approved. Tauri's runtime ACL
-- gets re-built from these rows at boot via add_capability().
CREATE TABLE IF NOT EXISTS pkg_permissions_granted (
  pkg_id       TEXT NOT NULL,
  scope_kind   TEXT NOT NULL,   -- 'shell.execute' | 'fs.read' | 'fs.write' | 'net' | ...
  scope_value  TEXT NOT NULL,   -- expanded path / URL / binary name
  granted_at   INTEGER NOT NULL,
  PRIMARY KEY (pkg_id, scope_kind, scope_value),
  FOREIGN KEY (pkg_id) REFERENCES pkg_installed(id) ON DELETE CASCADE
);
