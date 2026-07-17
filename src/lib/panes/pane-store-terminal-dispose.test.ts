import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeLeaf } from './pane-reducer';
import type { LeafNode, PaneNode, SplitNode } from './types';

// F-3 regression: closing a terminal tab must remove() the session (→ cascades
// evictXtermCache, shedding the WebglAddon) and disposePty() the leaked PTY —
// but a session still referenced by another live view (second terminal tab, or
// an artifact-studio attachedTerminalId) must keep its PTY. Split/move/switch
// must never dispose (those paths don't call releaseAttachments at all).

// releaseAttachments lazy-imports both stores; mock them so we can observe the
// calls without pulling in the real terminal store / pty bridge.
const removeMock = vi.fn();
const detachFromStudioMock = vi.fn();
const disposePtyMock = vi.fn();

vi.mock('@/terminal/session-store', () => ({
	useTerminalStore: {
		getState: () => ({
			remove: removeMock,
			detachFromStudio: detachFromStudioMock,
		}),
	},
}));

vi.mock('@/terminal/pty-registry', () => ({
	disposePty: disposePtyMock,
}));

// Imported after the mocks are declared (vi.mock is hoisted regardless).
import { usePaneStore } from './pane-store';

/** Flush the chained dynamic-import microtasks releaseAttachments schedules. */
async function flush(): Promise<void> {
	for (let i = 0; i < 8; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	for (let i = 0; i < 8; i++) await Promise.resolve();
}

function splitTree(a: LeafNode, b: LeafNode): SplitNode {
	return { type: 'split', direction: 'horizontal', children: [a, b], sizes: [0.5, 0.5] };
}

beforeEach(() => {
	removeMock.mockClear();
	detachFromStudioMock.mockClear();
	disposePtyMock.mockClear();
	const root = makeLeaf({ kind: 'route', path: '/test' });
	usePaneStore.getState().hydrate({ root, focusedId: root.id, closedHistory: [] });
});

describe('F-3 — terminal disposal on genuine close', () => {
	it('closing a terminal tab removes the session and disposes its PTY', async () => {
		const store = usePaneStore.getState();
		const rootId = store.focusedId;
		// leaf tabs = [route, terminal]; close the terminal at idx 1.
		store.addTab(rootId, { kind: 'terminal', sessionId: 'sess-1' });
		usePaneStore.getState().closeTab(rootId, 1);
		await flush();
		expect(removeMock).toHaveBeenCalledWith('sess-1');
		expect(disposePtyMock).toHaveBeenCalledWith('sess-1');
	});

	it('does NOT dispose a PTY still referenced by another terminal tab', async () => {
		// Two panes each hold a terminal tab for the SAME session (shared PTY).
		const leafA = makeLeaf({ kind: 'terminal', sessionId: 'shared' });
		const leafB = makeLeaf({ kind: 'terminal', sessionId: 'shared' });
		usePaneStore.getState().hydrate({
			root: splitTree(leafA, leafB),
			focusedId: leafA.id,
			closedHistory: [],
		});
		// Closing leafA's only tab collapses leafA; leafB's terminal survives.
		usePaneStore.getState().closeTab(leafA.id, 0);
		await flush();
		expect(removeMock).toHaveBeenCalledWith('shared');
		expect(disposePtyMock).not.toHaveBeenCalled();
	});

	it('does NOT dispose a PTY still attached to a live artifact-studio view', async () => {
		const term = makeLeaf({ kind: 'terminal', sessionId: 'attach-1' });
		const studio = makeLeaf({
			kind: 'artifact-studio',
			path: '/a.html',
			density: 'loupe',
			attachedTerminalId: 'attach-1',
		});
		usePaneStore.getState().hydrate({
			root: splitTree(term, studio),
			focusedId: term.id,
			closedHistory: [],
		});
		usePaneStore.getState().closeTab(term.id, 0);
		await flush();
		expect(removeMock).toHaveBeenCalledWith('attach-1');
		expect(disposePtyMock).not.toHaveBeenCalled();
	});

	it('closing an artifact-studio view detaches but never disposes the PTY', async () => {
		const term = makeLeaf({ kind: 'terminal', sessionId: 'keep-1' });
		const studio = makeLeaf({
			kind: 'artifact-studio',
			path: '/a.html',
			density: 'loupe',
			attachedTerminalId: 'keep-1',
		});
		usePaneStore.getState().hydrate({
			root: splitTree(term, studio),
			focusedId: studio.id,
			closedHistory: [],
		});
		// Close the studio pane's only tab; the terminal tab is untouched.
		usePaneStore.getState().closeTab(studio.id, 0);
		await flush();
		expect(detachFromStudioMock).toHaveBeenCalledWith('keep-1');
		expect(removeMock).not.toHaveBeenCalled();
		expect(disposePtyMock).not.toHaveBeenCalled();
	});

	it('splitting a pane with a terminal tab disposes nothing', async () => {
		const store = usePaneStore.getState();
		const rootId = store.focusedId;
		store.addTab(rootId, { kind: 'terminal', sessionId: 'no-dispose' });
		usePaneStore.getState().splitPane(rootId, 'horizontal');
		await flush();
		expect(removeMock).not.toHaveBeenCalled();
		expect(disposePtyMock).not.toHaveBeenCalled();
	});

	it('moving a terminal tab between panes disposes nothing', async () => {
		// Two panes; move the terminal from leafA into leafB.
		const leafA = makeLeaf({ kind: 'terminal', sessionId: 'moved' });
		const leafB = makeLeaf({ kind: 'route', path: '/b' });
		usePaneStore.getState().hydrate({
			root: splitTree(leafA, leafB),
			focusedId: leafA.id,
			closedHistory: [],
		});
		usePaneStore.getState().moveTab(leafA.id, 0, leafB.id, 'append');
		await flush();
		// The terminal is still live in leafB — nothing shed.
		expect(removeMock).not.toHaveBeenCalled();
		expect(disposePtyMock).not.toHaveBeenCalled();
		// Sanity: the move actually landed the terminal in leafB.
		const root = usePaneStore.getState().root as PaneNode;
		const found = referencesSession(root, 'moved');
		expect(found).toBe(true);
	});
});

/** True if any terminal tab in the tree carries `sessionId`. */
function referencesSession(node: PaneNode, sessionId: string): boolean {
	if (node.type === 'leaf') {
		return node.tabs.some((t) => t.kind === 'terminal' && t.sessionId === sessionId);
	}
	return node.children.some((c) => referencesSession(c, sessionId));
}
