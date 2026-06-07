-- 0047_content_domain.sql
-- WP-21b — Content domain tables for com.ikenga.content.
--
-- Creates three STRICT tables with soft TEXT links (no FK, per ikenga.db convention):
--   content_pieces          — full editorial pipeline record
--   content_published       — published-performance record (views, engagement_pct)
--   content_stage_transitions — per-piece stage history log
--
-- Stage enum (owned by this pkg): idea | outline | draft | review | scheduled
-- Terminal: published (pieces migrate to content_published on publish).
--
-- Schema note: content_calendar, social_queue, and calendar_events are pre-existing
-- tables (migrated earlier) and are not modified here. content_pieces.calendar_id
-- is a soft TEXT link to content_calendar.id for derivation tracking.

CREATE TABLE IF NOT EXISTS content_pieces (
  id                TEXT PRIMARY KEY,
  title             TEXT,
  content_type      TEXT,  -- blog | newsletter | social | video
  channel           TEXT,  -- royalti.io | listmonk | linkedin | x | youtube
  stage             TEXT,  -- idea | outline | draft | review | scheduled
  owner             TEXT,  -- nedjamez | blog-writer | content-agent | cmo-agent | social-agent
  next_action       TEXT,
  next_action_mode  TEXT,  -- confirm | silent | approve
  format            TEXT,  -- e.g. 1,800 wd | broadcast | post | pillar | video
  due_at            TEXT,
  calendar_id       TEXT,  -- soft link to content_calendar.id (may be NULL)
  created_at        TEXT DEFAULT (datetime('now'))
) STRICT;

CREATE TABLE IF NOT EXISTS content_published (
  id             TEXT PRIMARY KEY,
  piece_id       TEXT,  -- soft link to content_pieces.id (may be NULL for calendar-derived)
  title          TEXT,
  content_type   TEXT,
  channel        TEXT,
  published_at   TEXT,
  views          INTEGER,
  engagement_pct REAL
) STRICT;

CREATE TABLE IF NOT EXISTS content_stage_transitions (
  id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  piece_id        TEXT,  -- soft link to content_pieces.id
  from_stage      TEXT,
  to_stage        TEXT,
  transitioned_at TEXT DEFAULT (datetime('now')),
  transitioned_by TEXT   -- agent slug or user slug
) STRICT;
