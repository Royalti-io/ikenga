CREATE TABLE IF NOT EXISTS chat_threads (
  id TEXT PRIMARY KEY,
  adapter TEXT NOT NULL,           -- 'cli' | 'sdk' | 'pencil' (only 'cli' in v1)
  title TEXT,
  cwd TEXT,
  model TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  role TEXT NOT NULL,              -- 'user' | 'assistant' | 'system' | 'tool'
  content TEXT NOT NULL,           -- JSON-encoded; structured for tool calls
  metadata TEXT,                   -- JSON
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_thread ON chat_messages(thread_id, created_at);

CREATE TABLE IF NOT EXISTS adapter_configs (
  adapter TEXT PRIMARY KEY,
  config_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS layout_state (
  key TEXT PRIMARY KEY,            -- e.g. 'workspace.panels', 'sidepane.tab'
  value TEXT NOT NULL,             -- JSON
  updated_at INTEGER NOT NULL
);
