-- 0034_mail_outbound_ext — WP-10a: mail/outbound domain table missing from WP-02.
--
-- Down-mapped from LIVE Supabase introspection (PostgREST OpenAPI, service_role,
-- 2026-05-30) — NOT the drifted in-repo migrations. STRICT. uuid → TEXT,
-- jsonb (metadata) → TEXT, timestamptz → TEXT, integer → INTEGER. Cross-domain
-- FK (deal_id → sales_deals) dropped; kept as TEXT soft link. NOT NULL mirrors
-- live NOT-NULL-without-default columns.

CREATE TABLE IF NOT EXISTS outbound_sequences (
  id TEXT PRIMARY KEY,
  deal_id TEXT,
  contact_email TEXT NOT NULL,
  sequence_id TEXT NOT NULL,
  segment TEXT,
  current_step INTEGER,
  total_steps INTEGER NOT NULL,
  next_send_date TEXT,
  status TEXT,
  sent_count INTEGER,
  last_reply_at TEXT,
  pause_reason TEXT,
  listmonk_subscriber_id INTEGER,
  metadata TEXT,
  created_at TEXT,
  updated_at TEXT
) STRICT;
