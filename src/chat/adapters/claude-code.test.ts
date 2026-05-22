// Regression tests for ClaudeCodeAdapter.attach().
//
// The bug: attach() is called concurrently (a thread's mount hook + send(),
// fired near-simultaneously by the seeded-chat path). The dedupe guard checks
// `streams.has(threadId)`, but the entry used to be inserted only AFTER an
// `await chatNewSession(...)`. Two racing callers both passed the guard and
// each called `chatListen` → two live listeners on `chat://session/{id}` →
// every SessionUpdate delivered twice (doubled assistant text, duplicate
// tool-call cards). The fix claims the map slot synchronously before any await.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/tauri-cmd', () => ({
	chatCancel: vi.fn(),
	chatListen: vi.fn(),
	chatNewSession: vi.fn(),
	chatPrompt: vi.fn(),
	claudeListSessions: vi.fn(),
}));

vi.mock('@/lib/shell/active-project-cwd', () => ({
	activeProjectCwd: vi.fn(() => '/tmp'),
}));

import { chatListen, chatNewSession } from '@/lib/tauri-cmd';
import { acpUpdateToChatEvent, getClaudeCodeAdapterInstance } from './claude-code';

const listen = vi.mocked(chatListen);
const newSession = vi.mocked(chatNewSession);
const adapter = getClaudeCodeAdapterInstance();

beforeEach(async () => {
	await adapter.destroy(); // resets streams + sessioned maps
	listen.mockReset();
	newSession.mockReset();
	// chatNewSession resolves async — the await between the guard and the
	// (old) slot insertion is exactly the race window we're guarding.
	newSession.mockResolvedValue({} as never);
	listen.mockResolvedValue(vi.fn());
});

describe('ClaudeCodeAdapter.attach concurrency', () => {
	it('subscribes exactly once when two attaches race the same thread', async () => {
		await Promise.all([
			adapter.attach('thread-1', '/tmp'),
			adapter.attach('thread-1', '/tmp'),
		]);
		expect(listen).toHaveBeenCalledTimes(1);
		expect(newSession).toHaveBeenCalledTimes(1);
	});

	it('is a no-op on a thread already attached', async () => {
		await adapter.attach('thread-1', '/tmp');
		await adapter.attach('thread-1', '/tmp');
		expect(listen).toHaveBeenCalledTimes(1);
	});

	it('releases the slot on failure so a later attach can retry', async () => {
		listen.mockRejectedValueOnce(new Error('boom'));
		await expect(adapter.attach('thread-1', '/tmp')).rejects.toThrow('boom');

		// Slot was released → the retry actually re-subscribes.
		listen.mockResolvedValueOnce(vi.fn());
		await adapter.attach('thread-1', '/tmp');
		expect(listen).toHaveBeenCalledTimes(2);
	});

	it('subscribes per distinct thread', async () => {
		await Promise.all([
			adapter.attach('thread-a', '/tmp'),
			adapter.attach('thread-b', '/tmp'),
		]);
		expect(listen).toHaveBeenCalledTimes(2);
	});
});

// ─── acpUpdateToChatEvent: wire shape ────────────────────────────────────
//
// The ACP `ToolCallUpdate` struct uses `#[serde(flatten)]` on its `fields`
// member, so on the wire `status` / `rawOutput` / `content` land at the top
// level alongside `toolCallId` — NOT nested under a `fields` object. This
// adapter previously read `u.fields?.status`, which was always undefined, so
// every tool_call_update was silently dropped — every tool card stayed stuck
// on RUNNING forever. Verified against the live Rust schema by serializing
// SessionUpdate::ToolCallUpdate(...) and dumping the JSON:
//   { "sessionUpdate": "tool_call_update",
//     "toolCallId": "toolu_test",
//     "status": "completed" }

describe('acpUpdateToChatEvent — tool_call_update flat shape', () => {
	it('emits tool_result on completed with rawOutput', () => {
		const ev = acpUpdateToChatEvent({
			sessionUpdate: 'tool_call_update',
			toolCallId: 'toolu_42',
			status: 'completed',
			rawOutput: { stdout: '/home/me' },
		} as never);
		expect(ev).toEqual({
			kind: 'tool_result',
			id: 'toolu_42',
			output: { stdout: '/home/me' },
			isError: false,
		});
	});

	it('falls back to content when rawOutput is missing', () => {
		const ev = acpUpdateToChatEvent({
			sessionUpdate: 'tool_call_update',
			toolCallId: 'toolu_42',
			status: 'completed',
			content: [{ type: 'text', text: 'ok' }],
		} as never);
		expect(ev).toMatchObject({
			kind: 'tool_result',
			id: 'toolu_42',
			isError: false,
		});
	});

	it('emits tool_result with isError on failed', () => {
		const ev = acpUpdateToChatEvent({
			sessionUpdate: 'tool_call_update',
			toolCallId: 'toolu_42',
			status: 'failed',
			rawOutput: { error: 'boom' },
		} as never);
		expect(ev).toMatchObject({ kind: 'tool_result', isError: true });
	});

	it('returns null for in-progress updates (no FE-side representation)', () => {
		const ev = acpUpdateToChatEvent({
			sessionUpdate: 'tool_call_update',
			toolCallId: 'toolu_42',
			status: 'in_progress',
		} as never);
		expect(ev).toBeNull();
	});

	it('regression: does NOT pick up the old nested-fields shape', () => {
		// The shape the buggy code expected. If the wire ever changed back
		// to this, the assertion below would flip — keep this here so the
		// failure mode is loud, not silent.
		const ev = acpUpdateToChatEvent({
			sessionUpdate: 'tool_call_update',
			toolCallId: 'toolu_42',
			fields: { status: 'completed', rawOutput: { stdout: 'x' } },
		} as never);
		expect(ev).toBeNull();
	});
});

// ─── acpUpdateToChatEvent: messageId resolution ──────────────────────────
//
// ContentChunk's top-level `messageId` is gated behind the schema crate's
// `unstable_message_id` feature; our Rust mapper's `#[cfg(feature = ...)]`
// checks ikenga-desktop's own (undefined) feature, so it always stamps the
// id under `_meta.ikenga.messageId` instead. Verified by serializing
// chat_event_to_session_updates(ChatEvent::Text { message_id: Some(...) }):
//   {"sessionUpdate":"agent_message_chunk","content":{"type":"text",
//    "text":"hello"},"_meta":{"ikenga":{"messageId":"msg_abc123"}}}
// A missing messageId lets coalesceTail glue distinct assistant messages
// and breaks the JSONL reconciler's text/thinking dedup key.

describe('acpUpdateToChatEvent — messageId resolution', () => {
	it('reads messageId from _meta.ikenga (the shape Rust actually ships)', () => {
		const ev = acpUpdateToChatEvent({
			sessionUpdate: 'agent_message_chunk',
			content: { type: 'text', text: 'hello' },
			_meta: { ikenga: { messageId: 'msg_abc123' } },
		} as never);
		expect(ev).toEqual({ kind: 'text', delta: 'hello', messageId: 'msg_abc123' });
	});

	it('still reads a top-level messageId if the cfg ever gets wired', () => {
		const ev = acpUpdateToChatEvent({
			sessionUpdate: 'agent_message_chunk',
			content: { type: 'text', text: 'hi' },
			messageId: 'msg_top',
		} as never);
		expect(ev).toMatchObject({ kind: 'text', messageId: 'msg_top' });
	});

	it('applies the same resolution to thinking chunks', () => {
		const ev = acpUpdateToChatEvent({
			sessionUpdate: 'agent_thought_chunk',
			content: { type: 'text', text: 'pondering' },
			_meta: { ikenga: { messageId: 'msg_think' } },
		} as never);
		expect(ev).toEqual({ kind: 'thinking', delta: 'pondering', messageId: 'msg_think' });
	});

	it('leaves messageId undefined when neither location carries it', () => {
		const ev = acpUpdateToChatEvent({
			sessionUpdate: 'agent_message_chunk',
			content: { type: 'text', text: 'x' },
		} as never);
		expect(ev).toMatchObject({ kind: 'text', messageId: undefined });
	});
});
