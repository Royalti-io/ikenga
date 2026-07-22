-- 0056_email_actions.sql
-- Audit + undo log for server-side IMAP mailbox triage.
--
-- Written by `royalti-pa/scripts/imap-triage.ts`, which moves mail between IMAP
-- folders on the real mail server (not the local Thunderbird mbox tree — writing
-- those while Thunderbird runs corrupts the profile).
--
-- WHY THIS TABLE IS THE PRECONDITION FOR ANY BULK RUN
-- The first afternoon of dry-runs produced three separate misclassifications:
-- a Google Docs comment mention filed as bulk notification, Paystack marketing
-- filed as a tax receipt, and a "$20.00 payment was unsuccessful" notice heading
-- out of the inbox. Rules over 39k messages will keep being wrong in new ways.
-- Without a per-message record of what moved where and under which rule, a bad
-- rule is not reversible — so nothing is allowed to move until this exists.
--
-- `run_id` groups one invocation so an entire batch can be undone in one step.
-- `message_id` (RFC 5322 Message-ID) is carried alongside `uid` because a UID is
-- only meaningful within one folder+uidvalidity: after a move it is a new UID in
-- the destination, so the Message-ID is what survives to identify the message.

CREATE TABLE IF NOT EXISTS email_actions (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL,
  account       TEXT NOT NULL,
  uid           INTEGER,   -- UID in src_folder at the time of the action
  dest_uid      INTEGER,   -- UID in dest_folder after the move (UIDPLUS uidMap)
  message_id    TEXT,
  subject       TEXT,
  from_address  TEXT,
  rule          TEXT NOT NULL,
  tier          TEXT NOT NULL CHECK (tier IN ('A','B')),
  action        TEXT NOT NULL CHECK (action IN ('move','delete','flag','skip')),
  src_folder    TEXT NOT NULL,
  dest_folder   TEXT,
  dry_run       INTEGER NOT NULL DEFAULT 0,
  applied_at    TEXT NOT NULL DEFAULT (datetime('now')),
  undone_at     TEXT,
  undone_by     TEXT
);

-- Undo path: find everything a run moved, still un-undone.
CREATE INDEX IF NOT EXISTS idx_email_actions_run
  ON email_actions (run_id, undone_at);

-- "What happened to this message?" across folders and runs.
CREATE INDEX IF NOT EXISTS idx_email_actions_message
  ON email_actions (message_id);

-- Rule-effectiveness review: which rules fire most, and which get undone.
CREATE INDEX IF NOT EXISTS idx_email_actions_rule
  ON email_actions (rule, applied_at);

-- Resume support: the highest UID already processed per account+folder, so a
-- run interrupted partway through 25k messages does not redo or skip work.
CREATE TABLE IF NOT EXISTS email_triage_cursor (
  account     TEXT NOT NULL,
  folder      TEXT NOT NULL,
  last_uid    INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (account, folder)
);
