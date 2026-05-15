-- 0021_pkg_capability_snapshots.sql
-- Trust-review modal (2026-05-15): per-pkg snapshot of the last-approved
-- `capabilities` + `permissions` block. The kernel boot path diffs the
-- on-disk manifest against this snapshot; a mismatch parks the pkg
-- (skips register) until the user approves or rejects it via the
-- batch review modal.
--
-- Distinct from `pkg_permissions_granted` (Phase 9 sensitive-perms
-- trust gating), which is a per-tool-call gate against an unbounded
-- list of scope kinds. This table is single-row-per-pkg and stores
-- the full normalized capabilities + permissions JSON.
--
--   pkg_id                       — manifest id (PRIMARY KEY, one row per pkg).
--   manifest_capabilities_json   — normalized JSON of the capabilities +
--                                  permissions blocks at approval time.
--                                  Vectors are sorted so re-ordering doesn't
--                                  trip a re-prompt.
--   approved_at                  — unix millis (matches the other pkg_* tables).
--   approved_by_implicit         — 1 on first-install auto-approval (the
--                                  install itself is consent), 0 on
--                                  user-driven approval through the modal.

CREATE TABLE IF NOT EXISTS pkg_capability_snapshots (
  pkg_id                       TEXT PRIMARY KEY,
  manifest_capabilities_json   TEXT    NOT NULL,
  approved_at                  INTEGER NOT NULL,
  approved_by_implicit         INTEGER NOT NULL DEFAULT 0
);
