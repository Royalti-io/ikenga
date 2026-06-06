-- 0044_outbound_domain — WP-19b: outbound domain state tables.
--
-- Creates four tables for the `com.ikenga.outbound` domain pkg:
--
--   1. outbound_sequence_steps    — step definitions for drip sequences
--   2. outbound_email_approvals   — transactional + drip email approval queue
--   3. outbound_sent_log          — generic cross-channel sent log
--   4. outbound_newsletter_drafts — newsletter draft queue + approval state
--
-- Design decisions (all tables):
--   * NO FK constraints — soft TEXT links (per the 0025–0031 convention).
--   * STRICT — all column types enforced at the SQLite level.
--   * status TEXT — lifecycle values documented per table below.
--   * ux_mode TEXT — 'approve' | 'silent' | 'confirm' (per outbound.md §2.2).
--   * drafted_by TEXT — agent identity ('pa' | 'cmo' | 'cbo') for By-agent sidebar.
--   * channel TEXT — 'smtp' | 'resend' | 'listmonk' | 'buffer'.
--
-- Real tables already in ikenga.db that this domain reads (no DDL here):
--   email_sequences, outbound_sequences, fundraising_outreach,
--   newsletter_sends, social_queue
--
-- These four tables add the state that was "schema TBD" in 08-pkg-retrofit-recipe.md.
-- Declared in §Schema-TBD as WP-19b's domain migration (next free after 0043).

-- ─── 1. outbound_sequence_steps ──────────────────────────────────────────────
-- Defines individual steps in a drip sequence (email_sequences row = parent).
-- The outbound pkg's Sequences / Schedule (Active list) view uses this to
-- show step titles and delays for per-recipient chain inspection.
--
-- status: 'active' | 'draft' | 'paused'
-- delay_value + delay_unit: e.g. 3 + 'days' = send 3 days after previous step.

CREATE TABLE IF NOT EXISTS outbound_sequence_steps (
  id              TEXT PRIMARY KEY,
  sequence_id     TEXT NOT NULL,              -- soft link to email_sequences.id
  step_number     INTEGER NOT NULL,
  subject         TEXT NOT NULL,
  body            TEXT,
  delay_value     INTEGER NOT NULL DEFAULT 0,
  delay_unit      TEXT NOT NULL DEFAULT 'days',  -- 'hours' | 'days' | 'weeks'
  channel         TEXT NOT NULL DEFAULT 'resend',
  status          TEXT NOT NULL DEFAULT 'active',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
) STRICT;

CREATE INDEX IF NOT EXISTS idx_ob_seq_steps_seq ON outbound_sequence_steps (sequence_id, step_number);

-- ─── 2. outbound_email_approvals ─────────────────────────────────────────────
-- Approval queue for transactional + drip email drafts. Items land here when
-- the dispatching agent sets ux_mode = 'approve'. 'silent' items bypass this
-- table (they appear only in the Schedule view). 'confirm' items trigger an
-- inline confirm modal.
--
-- status: 'pending' | 'approved' | 'rejected' | 'scheduled' | 'sent'
-- is_overdue: 1 if scheduled_for is in the past and status = 'pending'
-- sequence_id: non-NULL when this is a sequence drip step (soft link).

CREATE TABLE IF NOT EXISTS outbound_email_approvals (
  id              TEXT PRIMARY KEY,
  subject         TEXT NOT NULL,
  body            TEXT,
  recipient_email TEXT,
  recipient_name  TEXT,
  channel         TEXT NOT NULL DEFAULT 'resend', -- 'smtp' | 'resend' | 'listmonk'
  status          TEXT NOT NULL DEFAULT 'pending',
  ux_mode         TEXT NOT NULL DEFAULT 'approve',
  drafted_by      TEXT NOT NULL DEFAULT 'pa',     -- 'pa' | 'cmo' | 'cbo' | agent id
  sequence_id     TEXT,                           -- soft link to email_sequences.id (nullable)
  scheduled_for   TEXT,                           -- ISO-8601 datetime or NULL
  is_overdue      INTEGER NOT NULL DEFAULT 0,     -- 0/1 boolean
  approved_by     TEXT,
  approved_at     TEXT,
  rejected_reason TEXT,
  sent_at         TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
) STRICT;

CREATE INDEX IF NOT EXISTS idx_ob_email_approvals_status ON outbound_email_approvals (status);
CREATE INDEX IF NOT EXISTS idx_ob_email_approvals_drafted ON outbound_email_approvals (drafted_by);
CREATE INDEX IF NOT EXISTS idx_ob_email_approvals_sched ON outbound_email_approvals (scheduled_for);

-- ─── 3. outbound_sent_log ─────────────────────────────────────────────────────
-- Generic cross-channel sent log. All four channels (email, newsletter, social,
-- sequence step) write a row here on successful send. The Sent view in the
-- outbound pkg reads from this table (filtered by channel) and from the existing
-- channel-specific tables (newsletter_sends for newsletter; social_queue for
-- social). This table is the unified source for the Email channel's Sent view
-- and the generic sent history for Sequences.
--
-- channel: 'email' | 'newsletter' | 'social' | 'sequence'
-- delivery_system: 'smtp' | 'resend' | 'listmonk' | 'buffer'
-- source_id: soft link to the originating row (outbound_email_approvals.id,
--            newsletter_sends.id, social_queue.id, etc.)

CREATE TABLE IF NOT EXISTS outbound_sent_log (
  id              TEXT PRIMARY KEY,
  channel         TEXT NOT NULL,              -- 'email' | 'newsletter' | 'social' | 'sequence'
  subject         TEXT,
  recipient_email TEXT,
  delivery_system TEXT NOT NULL DEFAULT 'resend',
  status          TEXT NOT NULL DEFAULT 'sent',
  source_id       TEXT,                       -- soft link to originating row
  drafted_by      TEXT,
  sent_at         TEXT NOT NULL DEFAULT (datetime('now')),
  open_rate       REAL,
  click_rate      REAL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
) STRICT;

CREATE INDEX IF NOT EXISTS idx_ob_sent_log_channel ON outbound_sent_log (channel, sent_at);
CREATE INDEX IF NOT EXISTS idx_ob_sent_log_delivery ON outbound_sent_log (delivery_system);

-- ─── 4. outbound_newsletter_drafts ────────────────────────────────────────────
-- Newsletter draft queue + approval state. Campaign drafts land here when the
-- CMO agent sets ux_mode = 'approve'. Items progress through:
--   'pending' → 'cooling' → 'approved' → (published to newsletter_sends)
--
-- cooling_until: ISO-8601 datetime; while now() < cooling_until, the Approve
--   CTA is blocked (the Newsletter / Approval queue view shows the cooling chip).
-- quality_score: 0..100 integer from the newsletter quality checker
--   (pre-send check runs asynchronously; NULL until the check resolves).
-- has_ab: 0/1 boolean — whether this draft has a B subject line.
-- subject_b: alternative subject for A/B test; NULL when has_ab = 0.
-- recipient_count: subscriber count at draft time (for the list-row preview).

CREATE TABLE IF NOT EXISTS outbound_newsletter_drafts (
  id              TEXT PRIMARY KEY,
  subject         TEXT NOT NULL,
  subject_b       TEXT,                           -- A/B variant subject; NULL = no A/B
  body            TEXT,
  draft_slug      TEXT,                           -- soft link to newsletter_sends.draft_slug
  edition         TEXT,
  delivery_system TEXT NOT NULL DEFAULT 'listmonk',
  status          TEXT NOT NULL DEFAULT 'pending',
  ux_mode         TEXT NOT NULL DEFAULT 'approve',
  drafted_by      TEXT NOT NULL DEFAULT 'cmo',
  cooling_until   TEXT,                           -- ISO-8601; NULL = no cooling
  quality_score   INTEGER,                        -- 0..100; NULL until checker runs
  has_ab          INTEGER NOT NULL DEFAULT 0,     -- 0/1 boolean
  recipient_count INTEGER,                        -- subscriber count at draft time
  approved_by     TEXT,
  approved_at     TEXT,
  rejected_reason TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
) STRICT;

CREATE INDEX IF NOT EXISTS idx_ob_nl_drafts_status ON outbound_newsletter_drafts (status);
CREATE INDEX IF NOT EXISTS idx_ob_nl_drafts_drafted ON outbound_newsletter_drafts (drafted_by);
