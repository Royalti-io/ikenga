// Pane-tree persistence. Stored as a versioned blob in the SQLite
// `layout_state` kv at key `workspace.pane-tree`, alongside the existing
// `workspace.panels` (sidebar/content sizes) entry.
//
// Hydrate semantics: tabs whose backing session is gone are dropped.
// Terminal tabs require an entry in `useTerminalStore` (which must be
// rehydrated first by the caller); chat tabs are kept when their
// sessionId looks like a Claude session UUID (the chat module hydrates
// them from `~/.claude/projects/**` on mount). Placeholder sessionIds
// minted by new-tab-menu (`chat-<timestamp>`) are dropped on restart
// since they don't map to any on-disk session. After filtering, any
// leaf with zero tabs is removed; any split with one remaining child
// collapses; if the whole tree is empty, we fall back to a single
// route('/') leaf.

import { loadLayoutState, saveLayoutState, debounce } from '@/lib/layout-state';
import { useTerminalStore } from '@/terminal/session-store';
import { findLeaf, getLeafIdsInOrder, makeLeaf } from './pane-reducer';
import type { PaneId, PaneNode, PaneView } from './types';

const STORE_KEY = 'workspace.pane-tree';
const VERSION = 1 as const;
export const MAX_CLOSED_HISTORY = 10;

export interface PersistedPaneTree {
	version: typeof VERSION;
	root: PaneNode;
	focusedId: PaneId;
	closedHistory: PaneView[];
}

export interface PaneTreeSnapshot {
	root: PaneNode;
	focusedId: PaneId;
	closedHistory: PaneView[];
}

function buildDefault(): { root: PaneNode; focusedId: PaneId } {
	const root = makeLeaf({ kind: 'route', path: '/' });
	return { root, focusedId: root.id };
}

function defaultSnapshot(): PaneTreeSnapshot {
	return { ...buildDefault(), closedHistory: [] };
}

/**
 * Read the persisted tree, validate sessions, return a clean snapshot.
 * Caller must have rehydrated `useTerminalStore` first or every
 * terminal tab will be considered stale.
 */
export async function loadPaneTree(): Promise<PaneTreeSnapshot> {
	const fallback: PersistedPaneTree = {
		version: VERSION,
		...buildDefault(),
		closedHistory: [],
	};

	let blob: PersistedPaneTree;
	try {
		blob = await loadLayoutState<PersistedPaneTree>(STORE_KEY, fallback);
	} catch (err) {
		console.warn('[pane-persistence] load failed, using default', err);
		return defaultSnapshot();
	}

	if (!blob || typeof blob !== 'object') return defaultSnapshot();
	if (blob.version !== VERSION) {
		console.warn(
			`[pane-persistence] version mismatch (got ${blob.version}, want ${VERSION}), using default`
		);
		return defaultSnapshot();
	}
	if (!blob.root || (blob.root.type !== 'leaf' && blob.root.type !== 'split')) {
		return defaultSnapshot();
	}

	const liveTerminalIds = new Set(useTerminalStore.getState().tabs.map((t) => t.id));
	const cleaned = filterTreeViews(blob.root, (view) => isViewLive(view, liveTerminalIds));

	if (!cleaned) return { ...buildDefault(), closedHistory: blob.closedHistory ?? [] };

	const focusedId = findLeaf(cleaned, blob.focusedId)
		? blob.focusedId
		: (getLeafIdsInOrder(cleaned)[0] ?? '');

	return {
		root: cleaned,
		focusedId,
		closedHistory: (blob.closedHistory ?? []).slice(-MAX_CLOSED_HISTORY),
	};
}

function isViewLive(view: PaneView, liveTerminalIds: Set<string>): boolean {
	switch (view.kind) {
		case 'route':
		case 'artifact':
		case 'scratchpad':
			// Scratchpad tabs hydrate on mount via /iyke/scratchpad/read.
			// If the underlying scratchpad was deleted, the view shows a
			// "not found" state but the tab itself stays restorable.
			return true;
		case 'terminal':
			return liveTerminalIds.has(view.sessionId);
		case 'chat':
			// Keep when sessionId is a Claude session UUID (the chat module
			// hydrates from `~/.claude/projects/**` on mount). Drop placeholder
			// ids minted by new-tab-menu — those don't map to on-disk sessions.
			return UUID_RE.test(view.sessionId);
		case 'tool-output':
			// Tool-output viewers are tied to a specific tool_use id in a
			// thread's event stream. The chat module hydrates events on mount,
			// so the viewer can resolve its pair (or render the "stale"
			// placeholder if the pair was pruned).
			return true;
	}
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function equalSizes(n: number): number[] {
	if (n <= 0) return [];
	const base = Math.floor(100 / n);
	const sizes = new Array(n).fill(base);
	sizes[n - 1] = 100 - base * (n - 1);
	return sizes;
}

/** Exported for tests. Returns null if the entire tree was filtered out. */
export function filterTreeViews(node: PaneNode, keep: (v: PaneView) => boolean): PaneNode | null {
	if (node.type === 'leaf') {
		const tabs = node.tabs.filter(keep);
		if (tabs.length === 0) return null;
		const activeTabIdx = Math.min(node.activeTabIdx, tabs.length - 1);
		return { ...node, tabs, activeTabIdx };
	}
	const children: PaneNode[] = [];
	for (const c of node.children) {
		const r = filterTreeViews(c, keep);
		if (r) children.push(r);
	}
	if (children.length === 0) return null;
	if (children.length === 1) return children[0];
	return { ...node, children, sizes: equalSizes(children.length) };
}

const persistDebounced = debounce((blob: PersistedPaneTree) => {
	void saveLayoutState(STORE_KEY, blob);
}, 500);

export function persistPaneTree(snapshot: PaneTreeSnapshot): void {
	persistDebounced({ version: VERSION, ...snapshot });
}
