/**
 * SQLite persistence for chat threads + messages. The on-disk Claude JSONL
 * remains the canonical event log; SQLite stores enough metadata for the
 * thread list to render without re-scanning JSONL, plus per-turn message
 * snapshots so reopening a thread is instant.
 *
 * Schema lives in migrations 0001_init.sql + 0003_claude_sessions.sql.
 */

import { dbExec, dbQuery, type ChatEvent } from '@/lib/tauri-cmd';
import type { ChatThread } from './adapter';

interface ChatThreadRow {
	id: string;
	adapter: string;
	title: string | null;
	cwd: string | null;
	model: string | null;
	created_at: number;
	updated_at: number;
	claude_session_id: string | null;
	project_dir: string | null;
	pty_id: string | null;
}

function rowToThread(r: ChatThreadRow): ChatThread {
	return {
		id: r.id,
		adapterId: r.adapter,
		title: r.title,
		cwd: r.project_dir ?? r.cwd ?? '',
		model: r.model,
		claudeSessionId: r.claude_session_id,
		ptyId: r.pty_id,
		createdAt: r.created_at,
		updatedAt: r.updated_at,
	};
}

export async function findThreadByClaudeSessionId(
	claudeSessionId: string
): Promise<ChatThread | null> {
	const rows = await dbQuery<ChatThreadRow>(
		`SELECT id, adapter, title, cwd, model, created_at, updated_at,
            claude_session_id, project_dir, pty_id
       FROM chat_threads
      WHERE claude_session_id = ?
      LIMIT 1`,
		[claudeSessionId]
	);
	return rows[0] ? rowToThread(rows[0]) : null;
}

export async function findThreadById(id: string): Promise<ChatThread | null> {
	const rows = await dbQuery<ChatThreadRow>(
		`SELECT id, adapter, title, cwd, model, created_at, updated_at,
            claude_session_id, project_dir, pty_id
       FROM chat_threads WHERE id = ? LIMIT 1`,
		[id]
	);
	return rows[0] ? rowToThread(rows[0]) : null;
}

export interface CreateThreadInput {
	id: string;
	adapterId: string;
	cwd: string;
	claudeSessionId: string | null;
	model: string | null;
	title: string | null;
}

export async function createThread(input: CreateThreadInput): Promise<void> {
	const now = Date.now();
	await dbExec(
		`INSERT OR IGNORE INTO chat_threads
       (id, adapter, claude_session_id, project_dir, cwd, model, title, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			input.id,
			input.adapterId,
			input.claudeSessionId,
			input.cwd,
			input.cwd,
			input.model,
			input.title,
			now,
			now,
		]
	);
}

export async function updateThreadMeta(
	id: string,
	fields: Partial<Pick<ChatThread, 'title' | 'model' | 'claudeSessionId' | 'ptyId' | 'cwd'>>
): Promise<void> {
	const sets: string[] = [];
	const params: (string | number | null)[] = [];
	if ('title' in fields) {
		sets.push('title = ?');
		params.push(fields.title ?? null);
	}
	if ('model' in fields) {
		sets.push('model = ?');
		params.push(fields.model ?? null);
	}
	if ('claudeSessionId' in fields) {
		sets.push('claude_session_id = ?');
		params.push(fields.claudeSessionId ?? null);
	}
	if ('ptyId' in fields) {
		sets.push('pty_id = ?');
		params.push(fields.ptyId ?? null);
	}
	if ('cwd' in fields) {
		sets.push('project_dir = ?', 'cwd = ?');
		params.push(fields.cwd ?? null, fields.cwd ?? null);
	}
	if (sets.length === 0) return;
	sets.push('updated_at = ?');
	params.push(Date.now());
	params.push(id);
	await dbExec(`UPDATE chat_threads SET ${sets.join(', ')} WHERE id = ?`, params);
}

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

export async function appendMessage(
	threadId: string,
	role: MessageRole,
	events: ChatEvent[]
): Promise<void> {
	if (events.length === 0) return;
	const id = `${threadId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
	await dbExec(
		`INSERT INTO chat_messages (id, thread_id, role, content, metadata, created_at)
     VALUES (?, ?, ?, ?, NULL, ?)`,
		[id, threadId, role, JSON.stringify(events), Date.now()]
	);
}

/** Cold-start hygiene: drop stale pty_id values left over from a previous
 *  app run. PTYs don't survive process exits. */
export async function clearLivePtys(): Promise<void> {
	await dbExec(`UPDATE chat_threads SET pty_id = NULL WHERE pty_id IS NOT NULL`, []);
}

// ─── User turns ───────────────────────────────────────────────────────────────
//
// Claude's JSONL records assistant turns + tool-result-shaped user envelopes,
// but NOT plain-string user messages — Claude treats them as transient input.
// We persist them ourselves in `chat_user_turns` (migration 0011) so the user
// side of the conversation survives reloads.
//
// Phase 11 audit (2026-05-11): considered dropping this table now that the
// chat path runs through ACP by default. The audit kept it. Reasons:
//   1. ACP `user_message_chunk` would carry user input back to us — but our
//      Rust `AcpServer.handle_prompt` does NOT emit one for our own writes,
//      it only forwards agent-side events. We accept the user's text via
//      `acp_prompt` and echo it into the store from the composer (synthetic
//      `user_turn` event); that echo is in-memory and dies on reload.
//   2. The on-disk JSONL (`~/.claude/projects/<slug>/<uuid>.jsonl`) drops
//      plain-string user messages in `stream_parser.rs::dispatch_user` —
//      only `tool_result`-shaped blocks survive into `ChatEvent`s.
// So `chat_user_turns` is the *only* durable record of what the user typed.
// Migration `0013_drop_chat_user_turns.sql` was scoped out. See
// `shell/docs/acp-migration.md` § Phase 11 for the decision log.

export interface UserTurnRow {
	id: string;
	thread_id: string;
	text: string;
	sequence: number;
	created_at: number;
}

export interface UserTurn {
	id: string;
	threadId: string;
	text: string;
	sequence: number;
	createdAt: number;
}

function rowToUserTurn(r: UserTurnRow): UserTurn {
	return {
		id: r.id,
		threadId: r.thread_id,
		text: r.text,
		sequence: r.sequence,
		createdAt: r.created_at,
	};
}

/** Append a user turn for this thread. Sequence increments monotonically per
 *  thread; we read max(sequence)+1 in the same call. Cheap on small threads;
 *  if this becomes hot we can cache in-memory off the store. */
export async function appendUserTurn(threadId: string, text: string): Promise<UserTurn> {
	const seqRows = await dbQuery<{ next_seq: number }>(
		`SELECT COALESCE(MAX(sequence), -1) + 1 AS next_seq
       FROM chat_user_turns WHERE thread_id = ?`,
		[threadId]
	);
	const sequence = seqRows[0]?.next_seq ?? 0;
	const id = `ut:${threadId}:${sequence}:${Math.random().toString(36).slice(2, 8)}`;
	const createdAt = Date.now();
	await dbExec(
		`INSERT INTO chat_user_turns (id, thread_id, text, sequence, created_at)
     VALUES (?, ?, ?, ?, ?)`,
		[id, threadId, text, sequence, createdAt]
	);
	return { id, threadId, text, sequence, createdAt };
}

/** Load all user turns for a thread in send order. */
export async function loadUserTurns(threadId: string): Promise<UserTurn[]> {
	const rows = await dbQuery<UserTurnRow>(
		`SELECT id, thread_id, text, sequence, created_at
       FROM chat_user_turns
      WHERE thread_id = ?
      ORDER BY sequence ASC`,
		[threadId]
	);
	return rows.map(rowToUserTurn);
}
