-- 0051_pa_action_drafts_send_state.sql — mutation-worker claim + retry + delivery columns.
--
-- Extends 0050 (pa_action_drafts). The EXTERNAL mutation worker (agent-scheduler daemon job)
-- claims committed rows, sends via SMTP/Resend/Listmonk/Buffer, and writes outcome back here.
-- No FKs (TEXT soft links, consistent with 0025-0050). No triggers (see 0048). SQLite has no
-- ALTER COLUMN / add-CHECK, so `status` stays free-text TEXT — the enum is a code-enforced
-- convention (Rust commands/pa_actions.rs + worker), now extended with: sending | failed.
--
-- status lifecycle: awaiting -> edited? -> committed -> sending -> sent
--                                                      \-> failed  (retry: failed -> committed)
--                                       (any active)   \-> rejected
--
-- The claim is the exactly-once gate (G-CLAIM):
--   UPDATE pa_action_drafts
--      SET status='sending', claimed_at=datetime('now'), attempts=attempts+1, last_attempt_at=datetime('now')
--    WHERE id=? AND status='committed';            -- assert changes()==1 in the worker
-- A reaper reclaims rows stuck in 'sending' (worker crashed mid-send) — but ONLY where the
-- provider id was never written (external_id IS NULL). A row WITH an external_id already went out;
-- reclaiming it would DOUBLE-SEND (G-05/R8). And N must EXCEED the worst-case single-send wall-time
-- (tie N to the job's timeout_ms, NOT a hardcoded 10 min — a slow Listmonk create+start could
-- otherwise be reclaimed mid-flight):
--   UPDATE ... SET status='committed'
--    WHERE status='sending' AND external_id IS NULL AND claimed_at < datetime('now','-<N>');

ALTER TABLE pa_action_drafts ADD COLUMN claimed_at          TEXT;
ALTER TABLE pa_action_drafts ADD COLUMN attempts            INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pa_action_drafts ADD COLUMN last_attempt_at     TEXT;
ALTER TABLE pa_action_drafts ADD COLUMN error_text          TEXT;
ALTER TABLE pa_action_drafts ADD COLUMN external_id         TEXT;   -- provider message/campaign/post id
ALTER TABLE pa_action_drafts ADD COLUMN delivery_status     TEXT;   -- null|accepted|delivered|bounced|complained|errored
ALTER TABLE pa_action_drafts ADD COLUMN delivery_checked_at TEXT;

-- Claim query predicate. scheduled_at MUST be stored as normalized UTC 'YYYY-MM-DD HH:MM:SS' —
-- the shell converts scheduledIso -> UTC in pa_actions_pause at insert (DEC-10), NOT raw ISO with a
-- 'T'/offset — else the lexical TEXT compare against SQLite's UTC datetime('now') is wrong (G-07):
--   WHERE status='committed' AND (scheduled_at IS NULL OR scheduled_at <= datetime('now'))
CREATE INDEX IF NOT EXISTS idx_pa_drafts_claimable ON pa_action_drafts(status, scheduled_at);
