-- 0049_task_signals.sql — per-task auto-close confidence signal (B.3 of the
-- 2026-06-07 atelier review). The Sweeper's 4-segment confidence bar was a fixed
-- structural tier (no per-row score). This table gives it a real per-row score
-- DERIVED from existing signals — the cohort tier (auto-closed vs flagged) plus
-- evidence richness (length of the outcome_notes the sweeper recorded).
--
-- signal_source is 'derived' so the UI labels it honestly (it is a transparent
-- heuristic, not a model score). A future real scorer can UPSERT rows here with
-- signal_source = '<scorer>' and no schema change.
--
-- No triggers (see 0048). INSERT OR REPLACE keeps the one-time backfill
-- idempotent. Scoped to the two cohorts the Sweeper surfaces (the only place an
-- auto-close confidence is semantically meaningful today).

CREATE TABLE IF NOT EXISTS task_signals (
  task_id TEXT PRIMARY KEY,
  confidence REAL,
  rule_tier TEXT,
  evidence_chars INTEGER,
  signal_source TEXT NOT NULL DEFAULT 'derived',
  computed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Auto-closed cohort: the sweeper already decided to close → high band (>= 0.90),
-- nudged up by evidence richness (length of outcome_notes).
INSERT OR REPLACE INTO task_signals (task_id, confidence, rule_tier, evidence_chars, signal_source, computed_at)
SELECT id,
       MIN(0.99, 0.90 + MIN(0.08, LENGTH(COALESCE(outcome_notes, '')) / 1500.0)),
       'auto',
       LENGTH(COALESCE(outcome_notes, '')),
       'derived',
       datetime('now')
FROM tasks
WHERE status = 'completed' AND outcome_notes LIKE 'Auto-closed by task-health%';

-- Flagged cohort: held below the auto-close threshold → mid band (0.60–0.89),
-- scaled by evidence richness.
INSERT OR REPLACE INTO task_signals (task_id, confidence, rule_tier, evidence_chars, signal_source, computed_at)
SELECT id,
       MAX(0.60, MIN(0.89, 0.66 + MIN(0.20, LENGTH(COALESCE(outcome_notes, '')) / 800.0))),
       'flag',
       LENGTH(COALESCE(outcome_notes, '')),
       'derived',
       datetime('now')
FROM tasks
WHERE status IN ('pending', 'in_progress', 'blocked')
  AND outcome_notes LIKE 'Needs review by task-health%';
