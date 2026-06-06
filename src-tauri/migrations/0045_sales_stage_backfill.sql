-- 0045_sales_stage_backfill — WP-18b live-verify follow-up (founder call 2026-06-06: "Both").
--
-- Live sales_deals rows predate the 0043 stage enum (06-skill-action-contract.md
-- §Pipeline-stages). Legacy values observed in the production ikenga.db:
-- 'cold' (x9) and 'closed_won' (x1). The 0043-documented enum is
-- lead → qualified → proposal → negotiation → closing → won|lost.
--
-- Map legacy → enum so the stage-grouped Pipeline list, the kanban columns,
-- and the Won view (stage = 'won') see canonical values. The sales pkg's
-- tolerant grouping (stagesWithExtras) guards any future non-enum value by
-- rendering it as its own visible group instead of dropping rows.
--
-- Naturally idempotent: the WHERE clauses no longer match after the update.

UPDATE sales_deals SET stage = 'lead' WHERE stage = 'cold';
UPDATE sales_deals SET stage = 'won'  WHERE stage = 'closed_won';
