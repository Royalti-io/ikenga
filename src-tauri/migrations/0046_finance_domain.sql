-- 0046_finance_domain.sql — WP-20b Finance domain state tables.
--
-- Adds the CFO-agent alert queue that the Finance pkg reads and the CFO agent
-- writes. No FK constraints (soft TEXT links — the 0025–0031 convention).
-- STRICT mode for type safety.
--
-- finance_alerts:
--   The agent-populated alert queue surfaced in the Finance Overview pane.
--   type: 'ar' (accounts receivable) | 'interco' (inter-company) | 'tax' | 'other'
--   severity: 'warn' | 'crit'
--   linked_id: soft TEXT ref to receivables.document_no or inter_company_entries.id
--   status: 'active' | 'dismissed' | 'resolved'

CREATE TABLE IF NOT EXISTS finance_alerts (
  id          TEXT    NOT NULL PRIMARY KEY,
  type        TEXT    NOT NULL,
  severity    TEXT    NOT NULL DEFAULT 'warn',
  message     TEXT    NOT NULL,
  linked_id   TEXT,
  status      TEXT    NOT NULL DEFAULT 'active',
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
) STRICT;

CREATE INDEX IF NOT EXISTS idx_finance_alerts_status    ON finance_alerts(status);
CREATE INDEX IF NOT EXISTS idx_finance_alerts_severity  ON finance_alerts(severity);
CREATE INDEX IF NOT EXISTS idx_finance_alerts_type      ON finance_alerts(type);
