-- 0053_research_domain.sql
-- WP-22b — Research domain schema for com.ikenga.research.
--
-- Extends the existing research_notes table (created in 0037_content_ext) with the
-- columns the Research screen needs, adds a monitored-source register table, and
-- adds a soft cross-domain link column on sales_deals for the "Hand to sales" flow.
--
-- Conventions (ikenga.db, the 0025-0031 soft-link convention):
--   - No FK constraints. Cross-domain links are plain TEXT (research_item_id,
--     research_notes.entity_id) resolved at query time, never enforced.
--   - One statement per ';' (the migration runner splits on every ';' and
--     forbids triggers and C-style block comments). Only -- line comments here.
--   - ALTER TABLE ADD COLUMN is safe to re-run: the runner treats a
--     "duplicate column name" error as already-applied.
--
-- Extended research_notes columns (all nullable, no defaults that would rewrite rows):
--   next_action         — .split-next card body copy
--   next_action_target  — cross-domain link destination (sales | product | content | battlecard)
--   agent_cycle_id      — soft link to the agent session log in the dock
--   is_stale            — 0/1 freshness flag (Sources/list staleness)
--   word_count          — detail eyebrow word count (else derived from body length)
--   owner               — explicit "Mine" vs agent-run split (alias of researched_by)

ALTER TABLE research_notes ADD COLUMN next_action TEXT;

ALTER TABLE research_notes ADD COLUMN next_action_target TEXT;

ALTER TABLE research_notes ADD COLUMN agent_cycle_id TEXT;

ALTER TABLE research_notes ADD COLUMN is_stale INTEGER;

ALTER TABLE research_notes ADD COLUMN word_count INTEGER;

ALTER TABLE research_notes ADD COLUMN owner TEXT;

-- Monitored-source register (Sources view). STRICT, no FK.
--   type    — Market | DDEX | Competitor | Prospect
--   cadence — daily | weekly | monthly
--   status  — fresh | signal | stale (freshness pill; semantic colour)
CREATE TABLE IF NOT EXISTS research_sources (
  id           TEXT PRIMARY KEY,
  name         TEXT,
  type         TEXT,
  cadence      TEXT,
  status       TEXT,
  last_checked TEXT
) STRICT;

-- Soft cross-domain link: a sales deal can reference the research note that
-- seeded it (the "Hand to sales" hand-off). Plain TEXT, no FK.
ALTER TABLE sales_deals ADD COLUMN research_item_id TEXT;
