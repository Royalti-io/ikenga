-- 0010_activity_bar_pinning.sql
-- User-level pinning for the activity bar / sidebar.
-- Two tables, deliberately separate from pkg-owned nav (UiRoutesRegistry):
--   * activity_bar_sections — user-created or seeded section headers
--   * activity_bar_pins     — user pins of artifacts/routes/files/etc.
--
-- Reserved section ids ('system', 'settings') are host-owned. The Rust
-- commands reject inserts with those ids. Section ids are slugified at the
-- Rust layer; SQL just treats them as opaque TEXT primary keys.

CREATE TABLE IF NOT EXISTS activity_bar_sections (
  id           TEXT PRIMARY KEY,
  label        TEXT NOT NULL,
  icon_lucide  TEXT,
  icon_emoji   TEXT,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS activity_bar_pins (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  target       TEXT NOT NULL,
  label        TEXT NOT NULL,
  icon_lucide  TEXT,
  icon_emoji   TEXT,
  section_id   TEXT REFERENCES activity_bar_sections(id) ON DELETE SET NULL,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pins_section ON activity_bar_pins(section_id, sort_order);
