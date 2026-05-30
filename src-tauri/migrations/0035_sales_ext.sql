-- 0035_sales_ext — WP-10a: sales domain table missing from WP-02.
--
-- Down-mapped from LIVE Supabase introspection (2026-05-30). STRICT.
-- uuid → TEXT, jsonb (metadata) → TEXT, timestamptz → TEXT. Cross-domain FK
-- (deal_id → sales_deals) dropped; kept as TEXT soft link.

CREATE TABLE IF NOT EXISTS sales_activities (
  id TEXT PRIMARY KEY,
  deal_id TEXT NOT NULL,
  activity_type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  performed_by TEXT,
  metadata TEXT,
  activity_date TEXT,
  created_at TEXT
) STRICT;
