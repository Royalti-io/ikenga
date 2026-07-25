-- WP-10 — link the agent execution graph to the durable task board.
--
-- `iyke_todos` is the runtime coordination graph an orchestrator builds for a
-- run (scope-partitioned, `blocker_id` encoding phase order). `tasks` is the
-- durable record of intent the human works from. Until now the two were
-- completely disconnected: no code joined them, so agent work was invisible on
-- the board and a todo could not say which task it served.
--
-- Nullable by design — plenty of coordination todos are pure scratch work with
-- no task behind them, and requiring a task id would push orchestrators into
-- inventing placeholder tasks. No FK: `tasks.id` rows outlive and predate the
-- iyke tables, and a hard reference would make task deletion fail rather than
-- simply orphaning a runtime todo.
ALTER TABLE iyke_todos ADD COLUMN task_id TEXT;

CREATE INDEX IF NOT EXISTS idx_iyke_todos_task ON iyke_todos(task_id);
