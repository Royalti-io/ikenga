// Unit tests for the `sendToActiveSession` core (WP-22 / G-ACTIVE-SESSION).
//
// Covers:
//   - source-stamp format (with + without `source`)
//   - active-chat-thread resolver (focused chat pane vs other pane kinds)
//   - ok path: appends the source-stamped turn, dispatches via the adapter
//   - no-active-session refusal: focused leaf isn't a chat pane
//   - no-active-session refusal: chat store hasn't hydrated the thread

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/chat/persist', () => ({
	appendUserTurn: vi.fn(),
}));
vi.mock('@/chat/registry', () => ({
	getAdapter: vi.fn(),
}));

import { appendUserTurn } from '@/chat/persist';
import { getAdapter } from '@/chat/registry';
import { useChatStore } from '@/chat/store';
import { usePaneStore } from '@/lib/panes/pane-store';
import { makeLeaf } from '@/lib/panes/pane-reducer';
import {
	resolveActiveChatThreadId,
	sendToActiveSession,
	sourceStamp,
} from './send-to-active-session';

const append = vi.mocked(appendUserTurn);
const adapter = vi.mocked(getAdapter);

function emptyIterable(): AsyncIterable<unknown> {
	return {
		[Symbol.asyncIterator]() {
			return {
				next: () => Promise.resolve({ done: true, value: undefined }),
			};
		},
	};
}

function hydrateChatPane(threadId: string): void {
	const root = makeLeaf({ kind: 'chat', sessionId: threadId });
	usePaneStore.getState().hydrate({ root, focusedId: root.id, closedHistory: [] });
}

function hydrateNonChatPane(): void {
	const root = makeLeaf({ kind: 'route', path: '/inbox' });
	usePaneStore.getState().hydrate({ root, focusedId: root.id, closedHistory: [] });
}

function seedThread(threadId: string, adapterId = 'claude-code'): void {
	useChatStore.getState().reset();
	useChatStore.getState().upsertThread({
		id: threadId,
		adapterId,
		engineId: adapterId,
		title: 't',
		cwd: '/tmp',
		model: null,
		claudeSessionId: null,
		ptyId: null,
		projectId: null,
		createdAt: 1,
		updatedAt: 1,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	useChatStore.getState().reset();
	// Default adapter mock: a fire-and-forget sink with an empty stream.
	adapter.mockReturnValue({
		id: 'claude-code',
		init: vi.fn(),
		attach: vi.fn(),
		send: vi.fn().mockReturnValue({ streamId: 's-1', iterable: emptyIterable() }),
		stop: vi.fn(),
	} as never);
	append.mockResolvedValue({
		threadId: 'thread-x',
		sequence: 1,
		text: '',
		createdAt: 1,
	} as never);
});

describe('sourceStamp', () => {
	it('prefixes with [via: groundwork/<source>] when source is provided', () => {
		expect(sourceStamp('hello', 'board')).toBe('[via: groundwork/board] hello');
		expect(sourceStamp('hello', 'palette')).toBe('[via: groundwork/palette] hello');
	});

	it('falls back to [via: groundwork/unknown] when source is omitted or empty', () => {
		expect(sourceStamp('hello', undefined)).toBe('[via: groundwork/unknown] hello');
		expect(sourceStamp('hello', '')).toBe('[via: groundwork/unknown] hello');
	});
});

describe('resolveActiveChatThreadId', () => {
	it('returns the focused chat pane thread id when one is focused', () => {
		hydrateChatPane('thread-42');
		expect(resolveActiveChatThreadId()).toBe('thread-42');
	});

	it('returns null when the focused pane is not a chat pane', () => {
		hydrateNonChatPane();
		expect(resolveActiveChatThreadId()).toBeNull();
	});
});

describe('sendToActiveSession', () => {
	it('appends a source-stamped user turn and dispatches via the adapter (ok path)', async () => {
		hydrateChatPane('thread-7');
		seedThread('thread-7');

		const adapterSend = vi.fn().mockReturnValue({ streamId: 's-1', iterable: emptyIterable() });
		adapter.mockReturnValue({
			id: 'claude-code',
			init: vi.fn(),
			attach: vi.fn(),
			send: adapterSend,
			stop: vi.fn(),
		} as never);

		const res = await sendToActiveSession({ prompt: 'refresh the board', source: 'board' });

		expect(res).toEqual({ ok: true, threadId: 'thread-7' });
		// The dispatched body carries the source-stamp.
		expect(append).toHaveBeenCalledWith('thread-7', '[via: groundwork/board] refresh the board');
		expect(adapterSend).toHaveBeenCalledWith({
			threadId: 'thread-7',
			text: '[via: groundwork/board] refresh the board',
		});
	});

	it("defaults the source-stamp to 'groundwork/unknown' when source is omitted", async () => {
		hydrateChatPane('thread-8');
		seedThread('thread-8');

		const res = await sendToActiveSession({ prompt: 'hi' });

		expect(res).toEqual({ ok: true, threadId: 'thread-8' });
		expect(append).toHaveBeenCalledWith('thread-8', '[via: groundwork/unknown] hi');
	});

	it("refuses with reason='no-active-session' when the focused pane is not a chat pane", async () => {
		hydrateNonChatPane();

		const res = await sendToActiveSession({ prompt: 'hello', source: 'board' });

		expect(res).toEqual({ ok: false, reason: 'no-active-session' });
		expect(append).not.toHaveBeenCalled();
	});

	it("refuses with reason='no-active-session' when the chat store hasn't hydrated the thread", async () => {
		hydrateChatPane('thread-not-loaded');
		// Deliberately do not seedThread() — chat store has no entry for it.

		const res = await sendToActiveSession({ prompt: 'hello' });

		expect(res).toEqual({ ok: false, reason: 'no-active-session' });
		expect(append).not.toHaveBeenCalled();
	});
});
