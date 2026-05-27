-- 0031_work_domain — Atelier/PA "work / observability extras".
--
-- Down-mapped from royalti-pa Supabase migration 034_cron_observability.sql:
--   cron_job_runs (the in-scope table per PART A "work extras", read 074).
-- (agent_handoffs lives in 0025_tasks_domain alongside agent_runs/reports.)
--
-- numeric(p,s) cost columns → TEXT (precision); int → INTEGER. jsonb → TEXT.
-- The sibling 034 tables agent_costs / system_health are NOT in PART A's
-- pkg-relevant scope, so they are omitted (FLAGGED as out-of-scope in report).

CREATE TABLE IF NOT EXISTS cron_job_runs (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  summary TEXT,
  duration_ms INTEGER,
  cost_usd TEXT,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cache_read_tokens INTEGER DEFAULT 0,
  num_turns INTEGER DEFAULT 0,
  session_id TEXT,
  report_id TEXT,
  created_at TEXT
) STRICT;
