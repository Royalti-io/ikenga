-- 0050_pa_action_drafts.sql — approve-gate run-then-pause draft queue.
--
-- Producer side of the approve-gate seam (plans/atelier/10-approve-gate-seam.md).
-- An approve-aware action does its work, then — instead of sending — hands the
-- shell a batch of drafts via host.paActionsPause; each becomes one row here with
-- status='awaiting'. The approve-gate panel at /outbox/approvals reads them, the
-- operator edits in place (edited_json), and on Approve & Send (after the 10s undo)
-- the row flips to 'committed' and a pa-action-committed event fires. The EXTERNAL
-- mutation worker performs the real send and writes status='sent' + sent_at. Reject
-- flips to 'rejected'. The shell never sends.
--
-- status lifecycle: awaiting -> edited? -> committed -> sent  (or -> rejected).
-- payload_json holds the DraftItem + ApproveGateMeta (the PausedDraft source).
-- edited_json holds operator subject/body overrides once edited. No FKs — consistent
-- with the 0025-0049 domain tables (TEXT soft links). No triggers (see 0048).

CREATE TABLE IF NOT EXISTS pa_action_drafts (
  id           TEXT PRIMARY KEY,
  batch_id     TEXT NOT NULL,
  action_id    TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'awaiting',
  channel      TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  edited_json  TEXT,
  scheduled_at TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  committed_at TEXT,
  sent_at      TEXT
);

CREATE INDEX IF NOT EXISTS idx_pa_drafts_status ON pa_action_drafts(status);

CREATE INDEX IF NOT EXISTS idx_pa_drafts_batch ON pa_action_drafts(batch_id);
