-- 0019_artifact_pin_metadata.sql
-- Phase 2 of the artifact-studio plan: enrich activity_bar_pins with the
-- artifact-specific fields needed for `ikenga://artifact/<id>` resolution
-- and recents sorting. The columns are nullable so non-artifact pins
-- (route/file/external/pkg-route) keep working unchanged.
--
--   manifest_id     — the `id` from the artifact's <script ikenga-manifest>.
--                     Lookup key for the ikenga:// URI scheme. Unique among
--                     pins that have it (NULL pins don't collide).
--   last_opened_at  — ISO-8601 UTC timestamp updated each time the pin is
--                     opened. Future "recently opened" sort orders read this.

ALTER TABLE activity_bar_pins ADD COLUMN manifest_id TEXT;
ALTER TABLE activity_bar_pins ADD COLUMN last_opened_at TEXT;

-- Partial unique index: NULLs don't participate, so non-artifact pins (and
-- artifact pins without a stable id) coexist freely. Two pins with the same
-- manifest_id would make ikenga:// resolution ambiguous, so SQLite enforces
-- the invariant at write time.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pins_manifest_id_unique
  ON activity_bar_pins(manifest_id) WHERE manifest_id IS NOT NULL;
