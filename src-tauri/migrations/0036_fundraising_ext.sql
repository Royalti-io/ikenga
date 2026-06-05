-- 0036_fundraising_ext — WP-10a: fundraising/partnerships domain table missing
-- from WP-02.
--
-- Down-mapped from LIVE Supabase introspection (2026-05-30). STRICT.
-- uuid → TEXT, date → TEXT, timestamptz → TEXT, integer → INTEGER.
-- Cross-domain FK (partnership_id → partnership_deals) dropped; TEXT soft link.

CREATE TABLE IF NOT EXISTS partnership_stage_transitions (
  id TEXT PRIMARY KEY,
  partnership_id TEXT NOT NULL,
  from_stage TEXT,
  to_stage TEXT NOT NULL,
  transition_date TEXT NOT NULL,
  days_in_previous_stage INTEGER,
  trigger TEXT,
  notes TEXT,
  created_at TEXT,
  updated_at TEXT
) STRICT;
