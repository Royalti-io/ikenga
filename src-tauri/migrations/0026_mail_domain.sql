-- 0026_mail_domain — Atelier/PA "mail / email" domain.
--
-- Down-mapped from royalti-pa Supabase migrations:
--   001_initial_schema.sql (email_messages base) + 005, 010, 048, 054 ALTERs
--   029_email_queue.sql (email_sequences + the OPERATIVE email_drafts shape)
--     + 030, 033, 040, 042, 053 email_drafts ALTERs
--   041_email_replies_table.sql (email_replies)
--
-- ⚠ email_drafts shape note (FLAGGED — see WP-02 report):
--   email_drafts is defined twice upstream — a thin shape in 001
--   (draft_body / email_message_id / reviewer_notes) and a rich shape in
--   029 (subject / body / sequence_id / delivery_system / metadata / …).
--   044_email_reply_drafts.sql:4-6 documents that the 001 columns were
--   "repurposed by the Listmonk sequence system" and 041 freely reads
--   email_drafts.{type,subject,body,recipients}. So the LIVE table is the
--   029-rich shape (NOT the 001 base). The 001-only columns draft_body /
--   email_message_id / reviewer_notes / approved_at(sent_at base) are
--   therefore intentionally ABSENT here. `type` comes from 033; the per-row
--   reply workflow that used draft_body now lives in email_reply_drafts
--   (out of WP-02 scope — not in PART A).
--
-- email_messages.body_text/body_html: dropped in 048, restored in 054 — net
-- present, so retained here.

CREATE TABLE IF NOT EXISTS email_messages (
  id TEXT PRIMARY KEY,
  inbox_source TEXT NOT NULL,
  message_id TEXT UNIQUE NOT NULL,
  subject TEXT,
  from_address TEXT NOT NULL,
  to_address TEXT,
  cc_address TEXT,
  body_text TEXT,
  body_html TEXT,
  triage_category TEXT,
  triage_reason TEXT,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  created_at TEXT,
  updated_at TEXT,
  -- 005_add_reply_to
  reply_to TEXT,
  -- 010_add_in_reply_to
  in_reply_to TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS email_sequences (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  description TEXT,
  total_steps INTEGER NOT NULL DEFAULT 1,
  step_delays TEXT NOT NULL DEFAULT '[0]',
  segment TEXT,
  targeting_criteria TEXT,
  delivery_system TEXT NOT NULL DEFAULT 'listmonk',
  delivery_config TEXT DEFAULT '{}',
  crm_person_id TEXT,
  crm_opportunity_id TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  created_by TEXT NOT NULL DEFAULT 'manual',
  approved_by TEXT,
  approved_at TEXT,
  metadata TEXT DEFAULT '{}',
  created_at TEXT,
  updated_at TEXT
) STRICT;

-- email_drafts: 029-rich shape + ALTERs (030/033/040/042/053). See note above.
CREATE TABLE IF NOT EXISTS email_drafts (
  id TEXT PRIMARY KEY,
  sequence_id TEXT,
  sequence_step INTEGER,
  subject TEXT NOT NULL,
  subject_alt TEXT,
  preheader TEXT,
  body TEXT NOT NULL,
  body_format TEXT NOT NULL DEFAULT 'plain',
  from_name TEXT NOT NULL DEFAULT 'Chinedum',
  from_email TEXT NOT NULL DEFAULT 'chinedum@royalti.io',
  reply_to TEXT,
  delivery_system TEXT NOT NULL DEFAULT 'listmonk',
  delivery_config TEXT DEFAULT '{}',
  recipients TEXT,
  personalization_fields TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  scheduled_for TEXT,
  created_by TEXT NOT NULL DEFAULT 'manual',
  approved_by TEXT,
  approved_at TEXT,
  rejected_at TEXT,
  rejection_reason TEXT,
  sent_at TEXT,
  send_result TEXT,
  error TEXT,
  slug TEXT UNIQUE,
  crm_person_id TEXT,
  crm_opportunity_id TEXT,
  metadata TEXT DEFAULT '{}',
  created_at TEXT,
  updated_at TEXT,
  -- 030_email_draft_reply_link
  reply_to_message_id TEXT,
  -- 033_newsletter_queue
  type TEXT NOT NULL DEFAULT 'outreach',
  reviewable_after TEXT,
  -- 040_email_drafts_reply_tracking
  reply_received INTEGER DEFAULT 0,
  reply_received_at TEXT,
  reply_classification TEXT,
  reply_handled_by TEXT,
  reply_handled_at TEXT,
  reply_message_ids TEXT DEFAULT '[]',
  sequence_exit INTEGER DEFAULT 0,
  sequence_exit_reason TEXT,
  ooo_return_date TEXT,
  -- 042_email_drafts_listmonk_campaign
  listmonk_campaign_id INTEGER,
  listmonk_campaign_status TEXT,
  -- 053_email_drafts_cc_bcc
  cc TEXT,
  bcc TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS email_replies (
  id TEXT PRIMARY KEY,
  parent_draft_id TEXT,
  reply_to_message_id TEXT,
  classification TEXT NOT NULL,
  subtype TEXT,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  body_format TEXT NOT NULL DEFAULT 'html',
  from_name TEXT NOT NULL,
  from_email TEXT NOT NULL,
  reply_to TEXT,
  delivery_system TEXT NOT NULL,
  recipients TEXT NOT NULL,
  cc TEXT DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending_review',
  approved_by TEXT,
  approved_at TEXT,
  rejected_at TEXT,
  rejection_reason TEXT,
  sent_at TEXT,
  send_result TEXT,
  error TEXT,
  created_by TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT,
  updated_at TEXT
) STRICT;
