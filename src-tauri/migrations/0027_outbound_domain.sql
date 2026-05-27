-- 0027_outbound_domain — Atelier/PA "outbound" domain.
--
-- Down-mapped from royalti-pa Supabase migrations:
--   028_social_queue.sql + 038 (social_queue + title ALTER)
--   046_newsletter_sends.sql + 047 (newsletter_sends + engagement ALTERs)
-- (email_sequences lives in 0026_mail_domain.)
--
-- CHECK constraints from the source (status / source / platform enums) are
-- dropped — the local store treats these as free-form TEXT per the type
-- down-map ("enums → TEXT, optionally CHECK"); we omit CHECK to keep the
-- migration robust against value drift in migrated rows.

CREATE TABLE IF NOT EXISTS social_queue (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL DEFAULT 'linkedin',
  account TEXT NOT NULL DEFAULT 'personal',
  content TEXT NOT NULL,
  media_path TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  scheduled_for TEXT,
  created_at TEXT NOT NULL,
  approved_at TEXT,
  approved_by TEXT,
  posted_at TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  error TEXT,
  proof_path TEXT,
  post_url TEXT,
  slug TEXT UNIQUE,
  -- 038_social_queue_title
  title TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS newsletter_sends (
  id TEXT PRIMARY KEY,
  draft_slug TEXT NOT NULL,
  edition TEXT,
  subject TEXT,
  subject_alt TEXT,
  delivery_system TEXT,
  campaign_id TEXT,
  sent_at TEXT,
  recipient_count INTEGER,
  open_rate REAL,
  click_rate REAL,
  stats_url TEXT,
  raw_stats TEXT DEFAULT '{}',
  created_at TEXT,
  updated_at TEXT,
  -- 047_newsletter_sends_engagement
  opens_count INTEGER,
  clicks_count INTEGER,
  bounces_count INTEGER,
  complaints_count INTEGER,
  bounce_rate REAL,
  complaint_rate REAL
) STRICT;
