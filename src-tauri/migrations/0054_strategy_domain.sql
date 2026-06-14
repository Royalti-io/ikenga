-- 0054_strategy_domain.sql
-- WP-23b — Strategy domain tables for com.ikenga.strategy.
--
-- Creates three STRICT tables with soft TEXT links (no FK, per ikenga.db convention):
--   strategy_objectives   — one row per OKR objective (area + cycle + overall %)
--   strategy_key_results  — KR rows per objective (label + pct + bar modifiers)
--   strategy_cycles       — quarterly planning cycles (status + counts + avg %)
--
-- Area enum (OKR board columns, owned by this pkg): Company | Growth | Product | Finance
-- ux_mode enum: confirm | silent | approve
-- Until these tables are seeded, the pane renders from real strategic_initiatives
-- (grouped by ties_to_goal for the area) and review_items (Reviews view).
--
-- Schema note: strategic_initiatives, architecture_decisions, ideas_backlog,
-- feature_score_history, and review_items are pre-existing tables and are not
-- modified here. strategy_objectives.cycle_id is a soft TEXT link to
-- strategy_cycles.id and strategy_key_results.objective_id is a soft TEXT link
-- to strategy_objectives.id (no FK constraint, query-time JOIN only).

CREATE TABLE IF NOT EXISTS strategy_objectives (
  id           TEXT PRIMARY KEY,
  title        TEXT,
  area         TEXT,    -- Company | Growth | Product | Finance
  cycle_id     TEXT,    -- soft link to strategy_cycles.id (may be NULL)
  overall_pct  INTEGER,
  owner        TEXT,    -- nedjamez | cmo-agent | cfo-agent | product-agent | strategy-agent
  ux_mode      TEXT,    -- confirm | silent | approve
  next_action  TEXT,
  created_at   TEXT DEFAULT (datetime('now'))
) STRICT;

CREATE TABLE IF NOT EXISTS strategy_key_results (
  id            TEXT PRIMARY KEY,
  objective_id  TEXT,   -- soft link to strategy_objectives.id
  label         TEXT,
  pct           INTEGER,
  is_low        INTEGER DEFAULT 0,
  is_mid        INTEGER DEFAULT 0
) STRICT;

CREATE TABLE IF NOT EXISTS strategy_cycles (
  id               TEXT PRIMARY KEY,
  name             TEXT,
  start_date       TEXT,
  end_date         TEXT,
  status           TEXT,   -- current | closed | planning
  objective_count  INTEGER,
  kr_count         INTEGER,
  avg_pct          INTEGER
) STRICT;
