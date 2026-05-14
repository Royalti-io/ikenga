-- Phase 9: trust gating versioning.
--
-- Reuse pkg_permissions_granted instead of a new pkg_trust table. Adds:
--   * version       — manifest version this row was approved against
--   * trust_state   — 'granted' | 'revoked'
--   * idx (pkg_id, version) for cheap diff lookup
--
-- Trust grants live alongside the existing capability rows but are tagged
-- scope_kind = '__manifest_trust' (sentinel; never collides with real
-- shell.execute / fs.write / net scope kinds). scope_value is the
-- sha256 hex of the perms snapshot at grant time, so updates that change
-- the declared globs invalidate the existing grant via mismatched value.

ALTER TABLE pkg_permissions_granted ADD COLUMN version TEXT;
ALTER TABLE pkg_permissions_granted ADD COLUMN trust_state TEXT NOT NULL DEFAULT 'granted';

CREATE INDEX IF NOT EXISTS idx_pkg_permissions_granted_pkg_version
    ON pkg_permissions_granted(pkg_id, version);
