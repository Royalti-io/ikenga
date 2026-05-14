-- 0016_iyke_memory.sql
-- Solo-inspired shared agent + memory primitives. The dominant scope is
-- the active project (resolved at request time in the bridge); workspace
-- and pkg scopes are opt-in for cross-project / pkg-owned state.
--
-- Wire scope format: "workspace" | "pkg:<id>" | "project:<id>".
-- Stored as opaque TEXT here — app layer validates + maps.
--
-- Phase 1 of the projects-first-class plan
-- (.company/technical/plans/2026-05-12-projects-first-class/02-phase-1-memory.md).
-- Implements DESIGN.md §2 of pkgs/mcp-iyke/.

CREATE TABLE IF NOT EXISTS iyke_scratchpads (
  id            TEXT PRIMARY KEY,
  scope         TEXT NOT NULL,
  name          TEXT NOT NULL,
  body          TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE (scope, name)
);
CREATE INDEX IF NOT EXISTS idx_iyke_scratchpads_scope ON iyke_scratchpads(scope);

CREATE TABLE IF NOT EXISTS iyke_todos (
  id            TEXT PRIMARY KEY,
  scope         TEXT NOT NULL,
  title         TEXT NOT NULL,
  body          TEXT,
  status        TEXT NOT NULL DEFAULT 'open',
  tags          TEXT NOT NULL DEFAULT '[]',
  blocker_id    TEXT,
  assignee      TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  completed_at  INTEGER,
  FOREIGN KEY (blocker_id) REFERENCES iyke_todos(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_iyke_todos_scope_status ON iyke_todos(scope, status);

CREATE TABLE IF NOT EXISTS iyke_todo_comments (
  id          TEXT PRIMARY KEY,
  todo_id     TEXT NOT NULL,
  author      TEXT NOT NULL,
  body        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (todo_id) REFERENCES iyke_todos(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS iyke_kv (
  scope       TEXT NOT NULL,
  key         TEXT NOT NULL,
  value       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (scope, key)
);

CREATE TABLE IF NOT EXISTS iyke_agents (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  model         TEXT,
  metadata      TEXT NOT NULL DEFAULT '{}',
  registered_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS iyke_locks (
  scope         TEXT NOT NULL,
  resource      TEXT NOT NULL,
  holder        TEXT NOT NULL,
  acquired_at   INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  PRIMARY KEY (scope, resource)
);
CREATE INDEX IF NOT EXISTS idx_iyke_locks_expires ON iyke_locks(expires_at);

CREATE TABLE IF NOT EXISTS iyke_timers (
  id          TEXT PRIMARY KEY,
  scope       TEXT NOT NULL,
  fire_at     INTEGER NOT NULL,
  agent_id    TEXT,
  title       TEXT NOT NULL,
  body        TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',
  created_at  INTEGER NOT NULL,
  fired_at    INTEGER,
  FOREIGN KEY (agent_id) REFERENCES iyke_agents(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_iyke_timers_pending ON iyke_timers(status, fire_at);

-- Agent inbox: synthetic events delivered to a registered agent on its
-- next tool call. v1 sources: timer-fired notices. 24h TTL via sweeper.
CREATE TABLE IF NOT EXISTS iyke_agent_inbox (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL,
  kind        TEXT NOT NULL,                       -- e.g. 'timer-fired'
  payload     TEXT NOT NULL,                       -- JSON
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (agent_id) REFERENCES iyke_agents(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_iyke_agent_inbox_agent ON iyke_agent_inbox(agent_id, created_at);
