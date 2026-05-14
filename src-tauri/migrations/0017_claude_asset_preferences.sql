-- 0017_claude_asset_preferences.sql
-- User-pinned resolutions for Claude-config asset name collisions across
-- the 4 discovery tiers (personal / workspace_pkg / project / project_pkg).
-- Phase 4 of the projects-first-class plan.
--
-- A pin is scoped (workspace or project:<id>) so the same asset name can
-- prefer different sources in different projects. When two tiers expose
-- the same asset name, discovery returns both; without a pin, the lower
-- tier wins by default (personal beats workspace_pkg beats project beats
-- project_pkg). The pin overrides that default.

CREATE TABLE IF NOT EXISTS claude_asset_preferences (
  scope           TEXT NOT NULL,                 -- 'workspace' or 'project:<id>'
  asset_kind      TEXT NOT NULL,                 -- 'skill' | 'agent' | 'command' | 'hook' | 'mcp'
  asset_name      TEXT NOT NULL,                 -- the slug/name as it appears to claude
  preferred_tier  TEXT NOT NULL,                 -- 'personal' | 'workspace_pkg' | 'project' | 'project_pkg'
  preferred_source TEXT,                         -- pkg id or 'personal'; nullable for personal tier
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (scope, asset_kind, asset_name)
);

CREATE INDEX IF NOT EXISTS idx_claude_asset_preferences_scope
  ON claude_asset_preferences(scope);
