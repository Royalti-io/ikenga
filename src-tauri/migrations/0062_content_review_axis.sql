-- 0062_content_review_axis.sql
-- WP-01 of .company/plans/2026-08-18-content-ops-authoring-layer.
--
-- Adds the APPROVAL axis to content_pieces. Founder ruling D-6: extend this
-- table rather than stand a third content table beside it and content_calendar.
--
-- TWO AXES, deliberately distinct. Do not let them drift into meaning the same
-- thing, or the review layer and the content app will silently disagree:
--
--   stage  -- where a piece is in PRODUCTION (idea|outline|draft|review|
--             scheduled). Owned by com.ikenga.content. NOT modified here.
--   status -- what a human DECIDED about it. Owned by the content-ops Drive
--             review layer (scripts/content-ops/).
--
-- Every column added here is nullable and no existing column is touched, so
-- rows created by the Ikenga content app keep working unchanged. The table
-- holds 0 rows today, but this migration does not rely on that.
--
-- status carries a real CHECK, unlike email_drafts.status, which has none --
-- SQLite silently stored 'aproved' there, after which a draft never sends or
-- never stops. Verified before writing this: SQLite permits CHECK on
-- ALTER TABLE ADD COLUMN, including on a STRICT table, enforces it, and still
-- allows NULL for rows the review layer has never seen.

ALTER TABLE content_pieces ADD COLUMN status TEXT
  CHECK (status IS NULL OR status IN (
    'draft', 'in_review', 'changes_requested', 'approved', 'published', 'rejected'
  ));

-- Idempotency key for the Drive publisher: the blog draft directory slug.
-- Nullable, because app-created rows have no filesystem draft behind them.
ALTER TABLE content_pieces ADD COLUMN ref TEXT;

-- Phase 3 bookkeeping (Docs stage export). doc_exported_stage records WHICH
-- numbered stage file was exported, so the import knows what it is superseding.
ALTER TABLE content_pieces ADD COLUMN doc_id TEXT;
ALTER TABLE content_pieces ADD COLUMN doc_exported_stage TEXT;
ALTER TABLE content_pieces ADD COLUMN doc_exported_at TEXT;

-- A hold is "not now", not a decision: the sync sets this and leaves status
-- alone, so a hold never consumes the queue the way a terminal 'rejected' does.
ALTER TABLE content_pieces ADD COLUMN reviewable_after TEXT;

-- No DEFAULT here: SQLite rejects a non-constant default on ADD COLUMN
-- ("Cannot add a column with non-constant default"). The writer sets it.
ALTER TABLE content_pieces ADD COLUMN updated_at TEXT;

-- PARTIAL, so the app-created rows that carry a NULL ref never collide with
-- each other. This is what makes the backfill and every re-publish idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS idx_content_pieces_ref
  ON content_pieces (content_type, ref) WHERE ref IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_content_pieces_status
  ON content_pieces (status) WHERE status IS NOT NULL;
