-- 0032_pure_etl_drift_fix — WP-10a drift repair for the "pure-ETL" domain tables.
--
-- The WP-02 schema (0025–0031) was down-mapped from royalti-pa's in-repo
-- supabase/migrations/*.sql. Those files had DRIFTED from the live Supabase
-- schema: six tables gained columns via later ALTERs that never made it into
-- the in-repo migration set. Live introspection (PostgREST OpenAPI, service_role,
-- 2026-05-30) found these live columns with no local home — without them the
-- WP-10 full-domain ETL would silently DROP data, violating the "full history"
-- decision. All are nullable in live (text / timestamptz / uuid → TEXT), so the
-- additions are purely additive.
--
-- ALTER TABLE ADD COLUMN is additive and STRICT-safe (TEXT, no NOT NULL without
-- default). The migration runner treats "duplicate column name" as
-- already-applied, so this is idempotent against a partially-patched db.
--
-- A recurring agent-session-binding trio (claude_session_id / working_dir /
-- last_activity_at) was added across many PA tables; the per-table extras are
-- email_drafts.delivery_external_id and newsletter_sends.draft_id.

ALTER TABLE fundraising_deals ADD COLUMN claude_session_id TEXT;
ALTER TABLE fundraising_deals ADD COLUMN working_dir TEXT;
ALTER TABLE fundraising_deals ADD COLUMN last_activity_at TEXT;

ALTER TABLE email_drafts ADD COLUMN claude_session_id TEXT;
ALTER TABLE email_drafts ADD COLUMN working_dir TEXT;
ALTER TABLE email_drafts ADD COLUMN last_activity_at TEXT;
ALTER TABLE email_drafts ADD COLUMN delivery_external_id TEXT;

ALTER TABLE email_replies ADD COLUMN claude_session_id TEXT;
ALTER TABLE email_replies ADD COLUMN working_dir TEXT;
ALTER TABLE email_replies ADD COLUMN last_activity_at TEXT;

ALTER TABLE sales_deals ADD COLUMN claude_session_id TEXT;
ALTER TABLE sales_deals ADD COLUMN working_dir TEXT;
ALTER TABLE sales_deals ADD COLUMN last_activity_at TEXT;

ALTER TABLE partnership_deals ADD COLUMN claude_session_id TEXT;
ALTER TABLE partnership_deals ADD COLUMN working_dir TEXT;
ALTER TABLE partnership_deals ADD COLUMN last_activity_at TEXT;

ALTER TABLE newsletter_sends ADD COLUMN draft_id TEXT;
ALTER TABLE newsletter_sends ADD COLUMN claude_session_id TEXT;
ALTER TABLE newsletter_sends ADD COLUMN working_dir TEXT;
ALTER TABLE newsletter_sends ADD COLUMN last_activity_at TEXT;
