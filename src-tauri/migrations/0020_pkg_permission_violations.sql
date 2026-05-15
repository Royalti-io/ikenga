-- 0020_pkg_permission_violations.sql
-- Runtime-ACL phase (2026-05-15): audit log for kernel-level permission
-- denials. Today only `shell.execute` writes here (when a pkg attempts to
-- spawn a binary outside its declared allowlist); future enforcement of
-- net / supabase / vault scopes will reuse the same table by setting a
-- different `scope_kind`.
--
--   pkg_id      — the offending pkg's manifest id.
--   scope_kind  — currently 'shell.execute'. New scope kinds extend the set.
--   attempted   — the value that was denied (e.g. resolved binary name for
--                 shell.execute). Free-text per scope_kind so future kinds
--                 can stash whatever shape they need.
--   declared    — comma-joined snapshot of the manifest's allowlist at the
--                 attempt time. Stored verbatim so a later allowlist edit
--                 doesn't silently rewrite history.
--   occurred_at — unix millis (matches `pkg_permissions_granted.granted_at`).

CREATE TABLE IF NOT EXISTS pkg_permission_violations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  pkg_id       TEXT    NOT NULL,
  scope_kind   TEXT    NOT NULL,
  attempted    TEXT    NOT NULL,
  declared     TEXT    NOT NULL,
  occurred_at  INTEGER NOT NULL
);

-- Compound index for the common query: "give me the last N violations for
-- this pkg, newest first." The Settings → Pkgs Review dialog (Phase 3) and
-- the iyke_pkg_violations_list MCP tool both hit this shape.
CREATE INDEX IF NOT EXISTS idx_pkg_perm_viol_pkg_time
  ON pkg_permission_violations (pkg_id, occurred_at DESC);
