-- 0058_email_index.sql
-- Headers-only index of every message in every mailbox.
--
-- Written by `royalti-pa/scripts/imap-ingest.ts`.
--
-- WHY A SECOND TABLE AND NOT A RESHAPE OF email_messages
-- Ingestion died 2026-06-17 and `email_messages` has been frozen at 985 rows
-- since. The obvious repair — "store headers, not bodies" — reads as a migration
-- of `email_messages`, but that table has 8+ live callers (ruby-email-poll,
-- resend-poll, auto-send-acks, email-enrich, triage, draft-generator,
-- draft-exporter, the com.ikenga.mail pkg) and several of them legitimately need
-- a body: you cannot generate a reply draft from a header. Those flows are also
-- low-volume by nature (inbound replies to our own outbound), which is the shape
-- full bodies actually suit.
--
-- The real corpus is a different problem with a different access pattern:
-- ~88k messages / 6.6GB across five mailboxes, which triage and proposal-scoring
-- only ever cluster, count and score. That never needs a body. At ~500 bytes of
-- headers per row, 88k messages is ~45MB and scales; 6.6GB of bodies does not.
--
-- So: `email_messages` keeps bodies for the reply/draft path, and this table is
-- the substrate `imap-triage.ts` and `imap-propose.ts` score against.
--
-- WHY uidvalidity IS A COLUMN AND NOT DECORATION
-- An IMAP UID is only meaningful within one (mailbox, UIDVALIDITY) generation.
-- If the server resets UIDVALIDITY — mailbox recreated, some server migrations —
-- every cached UID silently addresses a DIFFERENT message. `email_triage_cursor`
-- (0056) has no such column, which means a reset would make an `email_actions`
-- undo move the wrong mail back. The cursor here records it, and the ingest is
-- required to halt on a mismatch rather than carry a stale cursor forward.

CREATE TABLE IF NOT EXISTS email_index (
  -- sha1(account | folder | uidvalidity | uid) — stable across re-ingest of the
  -- same message, distinct across a UIDVALIDITY reset (see above).
  id             TEXT PRIMARY KEY,
  account        TEXT NOT NULL,
  folder         TEXT NOT NULL,
  uid            INTEGER NOT NULL,
  uidvalidity    INTEGER NOT NULL,

  -- RFC 5322 Message-ID. Survives moves between folders, so it is the only
  -- durable join key back to email_actions (same reasoning as 0056).
  message_id     TEXT,
  -- Threading signal. `imap-propose.ts` scores sender clusters on the ratio of
  -- mail that has been replied to, which is what separates live correspondence
  -- from automation far better than any hand-written domain list.
  in_reply_to    TEXT,
  references_ids TEXT,

  subject        TEXT,
  from_address   TEXT,
  from_name      TEXT,
  to_addresses   TEXT,
  cc_addresses   TEXT,
  date_sent      TEXT,
  size_bytes     INTEGER,

  -- Bulk-mail signals, extracted at ingest so scoring never re-reads headers.
  list_id        TEXT,
  has_list_unsub INTEGER NOT NULL DEFAULT 0,

  -- IMAP flags (\Seen, \Answered, \Flagged) as a comma-joined string. Refreshed
  -- on re-ingest; everything else is write-once.
  flags          TEXT,
  ingested_at    TEXT NOT NULL DEFAULT (datetime('now')),

  UNIQUE (account, folder, uidvalidity, uid)
);

-- Cluster-by-sender is the hot path for proposal scoring.
CREATE INDEX IF NOT EXISTS idx_email_index_from
  ON email_index (from_address);

-- Retention/age questions and "what arrived when" reporting.
CREATE INDEX IF NOT EXISTS idx_email_index_date
  ON email_index (date_sent);

-- Join back to email_actions, and dedup a message seen in two folders.
CREATE INDEX IF NOT EXISTS idx_email_index_message
  ON email_index (message_id);

-- Per-mailbox sweeps and the ingest's own resume checks.
CREATE INDEX IF NOT EXISTS idx_email_index_account_folder
  ON email_index (account, folder);

-- Separate from email_triage_cursor (0056) rather than an ALTER, because the two
-- advance independently: triage may be mid-run over a folder the ingest has
-- already indexed to the end, and collapsing them would make one clobber the
-- other's resume point.
CREATE TABLE IF NOT EXISTS email_ingest_cursor (
  account     TEXT NOT NULL,
  folder      TEXT NOT NULL,
  uidvalidity INTEGER NOT NULL,
  last_uid    INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (account, folder)
);
