/**
 * SQLite persistence for chat threads + messages. The on-disk Claude JSONL
 * remains the canonical event log; SQLite stores enough metadata for the
 * thread list to render without re-scanning JSONL, plus per-turn message
 * snapshots so reopening a thread is instant.
 *
 * Schema lives in migrations 0001_init.sql + 0003_claude_sessions.sql.
 */

import { type ChatEvent, dbExec, dbQuery } from '@/lib/tauri-cmd';
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
	project_id: string | null;
	pty_id: string | null;
	/** ADR-013 §2 — added by migration 0024. NOT NULL DEFAULT 'claude-code'
	 *  so pre-migration rows backfill cleanly. */
	engine_id: string;
}

function rowToThread(r: ChatThreadRow): ChatThread {
	return {
		id: r.id,
		adapterId: r.adapter,
		// Fall back to `adapter` for any row that pre-dates the migration
		// 0024 default backfill (defensive — the default covers all real
		// rows). The two-level picker uses `engineId` to detect mid-thread
		// engine divergence and fork-gating reads it for the engine_id
		// gate per ADR-013 §7 OQ#3.
		engineId: r.engine_id ?? r.adapter,
		title: r.title,
		cwd: r.project_dir ?? r.cwd ?? '',
		model: r.model,
		claudeSessionId: r.claude_session_id,
		ptyId: r.pty_id,
		projectId: r.project_id,
		createdAt: r.created_at,
		updatedAt: r.updated_at,
	};
}

export async function findThreadByClaudeSessionId(
	claudeSessionId: string
): Promise<ChatThread | null> {
	const rows = await dbQuery<ChatThreadRow>(
		`SELECT id, adapter, title, cwd, model, created_at, updated_at,
            claude_session_id, project_dir, project_id, pty_id, engine_id
       FROM chat_sessions
      WHERE claude_session_id = ?
      LIMIT 1`,
		[claudeSessionId]
	);
	return rows[0] ? rowToThread(rows[0]) : null;
}

export async function findThreadById(id: string): Promise<ChatThread | null> {
	const rows = await dbQuery<ChatThreadRow>(
		`SELECT id, adapter, title, cwd, model, created_at, updated_at,
            claude_session_id, project_dir, project_id, pty_id, engine_id
       FROM chat_sessions WHERE id = ? LIMIT 1`,
		[id]
	);
	return rows[0] ? rowToThread(rows[0]) : null;
}

export interface CreateThreadInput {
	id: string;
	adapterId: string;
	/** ADR-013 §2: the engine to pin this thread to. Defaults to the
	 *  `adapterId` when omitted — for the Phase 6 picker rewrite, the
	 *  composer's per-turn engine swap does NOT mint a new thread, so this
	 *  is set once at creation and never reassigned. */
	engineId?: string;
	cwd: string;
	claudeSessionId: string | null;
	model: string | null;
	title: string | null;
	/** Phase 3 of projects-first-class: every new thread is attached to a
	 *  project. Callers pass the shell's active project id (from
	 *  `useShellStore`). Nullable so legacy/test callsites don't break, but
	 *  the production callers always supply it. */
	projectId: string | null;
}

export async function createThread(input: CreateThreadInput): Promise<void> {
	const now = Date.now();
	// ADR-013 §2: `engine_id` defaults to `adapterId` for backward-compat —
	// today every FE call site mints a Claude-code thread, so the default
	// matches. New paths (e.g. onboarding-picked Gemini default) can pass
	// `engineId` explicitly. The column is NOT NULL DEFAULT 'claude-code' in
	// the schema (migration 0024), so omitting it from the INSERT would also
	// work, but we set it explicitly so the engine pin is intentional.
	const engineId = input.engineId ?? input.adapterId;
	await dbExec(
		`INSERT OR IGNORE INTO chat_sessions
       (id, adapter, engine_id, claude_session_id, project_dir, cwd, model, title, project_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			input.id,
			input.adapterId,
			engineId,
			input.claudeSessionId,
			input.cwd,
			input.cwd,
			input.model,
			input.title,
			input.projectId,
			now,
			now,
		]
	);
}

export async function updateThreadMeta(
	id: string,
	fields: Partial<
		Pick<ChatThread, 'title' | 'model' | 'claudeSessionId' | 'ptyId' | 'cwd' | 'projectId'>
	>
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
	if ('projectId' in fields) {
		sets.push('project_id = ?');
		params.push(fields.projectId ?? null);
	}
	if (sets.length === 0) return;
	sets.push('updated_at = ?');
	params.push(Date.now());
	params.push(id);
	await dbExec(`UPDATE chat_sessions SET ${sets.join(', ')} WHERE id = ?`, params);
}

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

/** Max serialized size we'll persist for a single tool_result `output`.
 *  Tool outputs (file reads, command dumps) are the only unbounded growth
 *  vector in a persisted turn — assistant prose / thinking is small. The
 *  full output stays available live; on reload a truncated copy is fine, so
 *  we cap it rather than let the table grow without bound. ~100 KB. */
const MAX_TOOL_OUTPUT_CHARS = 100_000;

/** Retention window for persisted message turns. On cold start we prune rows
 *  older than this; reload of an older thread falls back to the JSONL
 *  reconstruction (claude) or user-turns-only (engines without a transcript).
 *  90 days. */
export const MESSAGE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** Truncate any oversized `tool_result.output` before persisting. Returns a
 *  shallow copy with the offending event(s) capped; leaves everything else
 *  (text, thinking, tool_use, done) untouched. */
function capToolOutputs(events: ChatEvent[]): ChatEvent[] {
	return events.map((e) => {
		if (e.kind !== 'tool_result') return e;
		const serialized = JSON.stringify(e.output ?? null);
		if (serialized.length <= MAX_TOOL_OUTPUT_CHARS) return e;
		const head = serialized.slice(0, MAX_TOOL_OUTPUT_CHARS);
		return {
			...e,
			output: `${head}\n…[truncated ${serialized.length - MAX_TOOL_OUTPUT_CHARS} chars on persist]`,
		};
	});
}

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
		[id, threadId, role, JSON.stringify(capToolOutputs(events)), Date.now()]
	);
}

/** Cold-start retention: drop persisted message turns older than
 *  `MESSAGE_RETENTION_MS`. Keeps the durable assistant record bounded over
 *  time without a per-thread cap (which would break reload completeness for
 *  active threads). User turns (`chat_user_turns`) and session rows are left
 *  intact — only the assistant-turn snapshots age out. */
export async function pruneOldMessages(maxAgeMs: number = MESSAGE_RETENTION_MS): Promise<void> {
	const cutoff = Date.now() - maxAgeMs;
	await dbExec(`DELETE FROM chat_messages WHERE created_at < ?`, [cutoff]);
}

interface ChatMessageRow {
	id: string;
	role: string;
	content: string;
	created_at: number;
}

/** One persisted message turn: a group of coalesced `ChatEvent`s written in
 *  a single `appendMessage` call, plus the turn-end timestamp used to
 *  interleave it with user turns on reload. */
export interface PersistedMessage {
	id: string;
	role: MessageRole;
	events: ChatEvent[];
	createdAt: number;
}

/** Load all persisted message turns for a thread in write order. This is the
 *  durable assistant-side record introduced to stop reload from depending on
 *  claude's on-disk JSONL transcript. Rows whose `content` won't parse are
 *  skipped (defensive — a malformed row shouldn't blank the whole thread).
 *
 *  Pre-fix sessions (and any turn that crashed before turn-end) have zero
 *  rows here; the caller falls back to the JSONL reconstruction path. */
export async function loadMessages(threadId: string): Promise<PersistedMessage[]> {
	const rows = await dbQuery<ChatMessageRow>(
		`SELECT id, role, content, created_at
       FROM chat_messages
      WHERE thread_id = ?
      ORDER BY created_at ASC, id ASC`,
		[threadId]
	);
	const out: PersistedMessage[] = [];
	for (const r of rows) {
		let events: ChatEvent[];
		try {
			const parsed = JSON.parse(r.content);
			if (!Array.isArray(parsed)) continue;
			events = parsed as ChatEvent[];
		} catch {
			continue;
		}
		out.push({ id: r.id, role: r.role as MessageRole, events, createdAt: r.created_at });
	}
	return out;
}

/** Cold-start hygiene: drop stale pty_id values left over from a previous
 *  app run. PTYs don't survive process exits. */
export async function clearLivePtys(): Promise<void> {
	await dbExec(`UPDATE chat_sessions SET pty_id = NULL WHERE pty_id IS NOT NULL`, []);
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
// `<workspace>/plans/shell/docs/acp-migration.md` § Phase 11 for the decision log.

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
