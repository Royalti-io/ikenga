/**
 * R-1: the WP-05 empty-thread GC must not delete a row that another live
 * consumer still holds.
 *
 * Two `useThread` mounts can hold the same threadId at once — a chat pane
 * (`shell/panes/views/chat-view.tsx`) and a detached chat surface
 * (`shell/detached/surfaces/chat-surface.tsx`), or two panes in a split.
 * Before the fix, ANY unmount ran the DELETE; popping out a not-yet-typed
 * thread could therefore delete the row underneath the live detached view,
 * and the next `appendUserTurn` would fail its `chat_sessions` FK — losing
 * the user's typed message.
 */

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbExec = vi.fn(async () => {});
const attach = vi.fn(async () => {});

vi.mock('@/lib/tauri-cmd', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@/lib/tauri-cmd')>();
	return {
		...actual,
		dbExec: (...args: unknown[]) => dbExec(...(args as [])),
		claudeReadJsonl: async () => [],
	};
});

vi.mock('@/lib/shell/active-project-cwd', () => ({
	activeProjectCwd: () => '/tmp',
}));

vi.mock('./default-adapter', () => ({
	defaultChatAdapterId: () => 'claude-code',
}));

vi.mock('./registry', () => ({
	getAdapter: () => ({ id: 'claude-code', attach }),
}));

const ROW_CREATED_AT = 1_700_000_000_000;

vi.mock('./persist', () => ({
	findThreadById: async (id: string) => ({
		id,
		adapterId: 'claude-code',
		engineId: 'claude-code',
		title: null,
		cwd: '/tmp',
		model: null,
		claudeSessionId: null,
		ptyId: null,
		projectId: null,
		createdAt: ROW_CREATED_AT,
		updatedAt: ROW_CREATED_AT,
	}),
	createThread: async () => {},
	updateThreadMeta: async () => {},
	loadUserTurns: async () => [],
	loadMessages: async () => [],
	appendUserTurn: async () => ({ id: 'u1', text: '', sequence: 0, createdAt: 0 }),
	appendMessage: async () => {},
	pruneOldMessages: async () => {},
	clearLivePtys: async () => {},
}));

const { useDetachedSurfaces, markSurfaceDetached } = await import('@/lib/window/detached-surfaces');
const { useThread, __threadMountCounts } = await import('./hooks');

/** Let the hydration promise chain and the 0ms GC deferral both settle. */
async function settle() {
	await act(async () => {
		await new Promise((r) => setTimeout(r, 20));
	});
}

/** DELETE statements issued against chat_sessions, with their params. */
function deletes() {
	return dbExec.mock.calls.filter((c) =>
		String((c as unknown[])[0]).includes('DELETE FROM chat_sessions')
	) as unknown as [string, unknown[]][];
}

describe('empty-thread GC refcount', () => {
	beforeEach(() => {
		dbExec.mockClear();
		__threadMountCounts.clear();
		useDetachedSurfaces.setState({ surfaceToWindow: {} });
	});

	// The cross-window case: the pane is the ONLY holder in this realm, so the
	// refcount alone would happily delete — but a detached pop-out window (its
	// own JS realm, its own refcount) is live on the same row.
	it('does NOT delete when the thread is popped out into a detached window', async () => {
		const pane = renderHook(() => useThread('thread-popped'));
		await settle();

		// `chat-view.tsx` marks the surface detached optimistically, BEFORE the
		// pane unmounts — reproduce that ordering exactly.
		act(() => markSurfaceDetached('chat:thread-popped', 'detached-chat-abc'));
		pane.unmount();
		await settle();

		expect(deletes()).toHaveLength(0);
	});

	it('does NOT delete while a second consumer still holds the same threadId', async () => {
		const a = renderHook(() => useThread('thread-1'));
		const b = renderHook(() => useThread('thread-1'));
		await settle();

		// The pane pops out: one holder goes away, the detached one remains.
		a.unmount();
		await settle();
		expect(deletes()).toHaveLength(0);
		expect(__threadMountCounts.get('thread-1')).toBe(1);

		// Last holder closes — now the GC may run.
		b.unmount();
		await settle();
		expect(deletes()).toHaveLength(1);
	});

	it('survives a StrictMode-style unmount→remount without deleting', async () => {
		const h = renderHook(() => useThread('thread-2'));
		await settle();
		h.unmount();
		// Remount in the same tick, before the deferred zero-check runs.
		const again = renderHook(() => useThread('thread-2'));
		await settle();
		expect(deletes()).toHaveLength(0);

		again.unmount();
		await settle();
		expect(deletes()).toHaveLength(1);
	});

	it('never underflows the refcount', async () => {
		const h = renderHook(() => useThread('thread-3'));
		await settle();
		h.unmount();
		await settle();
		// Entry is cleaned up rather than left negative.
		expect(__threadMountCounts.get('thread-3') ?? 0).toBe(0);
	});

	it('fences the DELETE on the observed created_at and keeps all four guards', async () => {
		const h = renderHook(() => useThread('thread-4'));
		await settle();
		h.unmount();
		await settle();

		const [sql, params] = deletes()[0];
		expect(sql).toContain('claude_session_id IS NULL');
		expect(sql).toContain('title IS NULL');
		expect(sql).toContain('chat_user_turns');
		expect(sql).toContain('chat_messages');
		expect(sql).toContain('created_at = ?');
		expect(params).toEqual(['thread-4', ROW_CREATED_AT]);
	});
});
