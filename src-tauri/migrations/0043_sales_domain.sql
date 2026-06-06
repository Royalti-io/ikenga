-- 0043_sales_domain — WP-18b: app-layer columns for sales_deals.
--
-- Adds the columns the com.ikenga.sales pkg needs that are missing from the
-- existing `sales_deals` table (created in 0028_sales_gtm_domain.sql):
--   title           TEXT  — human-readable deal name (company is the entity;
--                           title is the opportunity description)
--   owner           TEXT  — the human or agent that owns this deal
--                           (mirrors assigned_to but is app-layer — assigned_to
--                           was down-mapped from Notion; owner is the Ikenga
--                           canonical field)
--   next_action     TEXT  — the next scheduled action description
--   next_action_mode TEXT — ux-mode of the next action: confirm | silent | approve
--                           (per the ActionFrontmatter contract in
--                           06-skill-action-contract.md §2 / §Pipeline-stages)
--   win_probability  REAL — 0.0–1.0 probability; used by the Forecast view for
--                           weighted pipeline: Σ(value × win_probability)
--
-- NO stored age_days — derived client-side from days_in_stage (existing column)
-- or computed from stage_entered_date.
--
-- Stage enum (documented in pkg README, enforced by application logic only —
-- SQLite STRICT enforces types, not enum sets):
--   Open stages:    lead | qualified | proposal | negotiation | closing
--   Terminal stages: won | lost
-- The Won view in the sales pkg queries:
--   SELECT * FROM sales_deals WHERE stage = 'won'
-- There is no sales_deals_won table — won deals are sales_deals rows at stage='won'.
--
-- Design decisions:
--   * NO FK constraints (soft TEXT links — per the 0025–0031 convention).
--   * All columns nullable TEXT/REAL — ALTER ADD COLUMN cannot have NOT NULL
--     without a default (SQLite constraint); the pkg treats NULL as the
--     pre-migration state and falls back to app-layer defaults.
--   * Idempotent — each ALTER is guarded by the migration runner's applied-id
--     check (_pa_migrations table); re-running this migration is a no-op.
--   * STRICT on the parent table is inherited — the column types declared here
--     are enforced at INSERT/UPDATE time.

ALTER TABLE sales_deals ADD COLUMN title TEXT;
ALTER TABLE sales_deals ADD COLUMN owner TEXT;
ALTER TABLE sales_deals ADD COLUMN next_action TEXT;
ALTER TABLE sales_deals ADD COLUMN next_action_mode TEXT;
ALTER TABLE sales_deals ADD COLUMN win_probability REAL;
