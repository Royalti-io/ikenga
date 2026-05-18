// Pane-tree persistence. Stored as a versioned blob in the SQLite
// `layout_state` kv at key `workspace.pane-tree` (one global key — pane
// layout is no longer scoped per project after the layout-swap rework;
// the user's last-touched arrangement is what they see on every project).
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

import { debounce, loadLayoutState, saveLayoutState } from '@/lib/layout-state';
import { useShellStore } from '@/lib/shell/shell-store';
import { useTerminalStore } from '@/terminal/session-store';
import { findLeaf, getLeafIdsInOrder, makeLeaf } from './pane-reducer';
import type { PaneId, PaneNode, PaneView } from './types';

export const STORE_KEY = 'workspace.pane-tree';
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
 *
 * One global key — pane layout no longer follows project switches. Any
 * pre-existing per-project rows (`workspace.pane-tree.${projectId}`) are
 * left in the kv table; harmless and not read.
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
	const ob = useShellStore.getState().onboarding;
	const dropOnboardingTabs = ob.mode === 'first_run' && ob.completedAt !== null;
	const filtered = filterTreeViews(
		blob.root,
		(view) => isViewLive(view, liveTerminalIds) && !isStaleOnboardingTab(view, dropOnboardingTabs)
	);

	if (!filtered) return { ...buildDefault(), closedHistory: blob.closedHistory ?? [] };

	// Second pass: clear `attachedTerminalId` on any `artifact-studio` view
	// whose referenced tab is no longer live. The Studio pane will fall
	// through to the picker on mount instead of showing the stale-attachment
	// notice — covered by S-2's mount effect.
	const cleaned = mapTreeViews(filtered, (view) => {
		if (
			view.kind === 'artifact-studio' &&
			view.attachedTerminalId &&
			!liveTerminalIds.has(view.attachedTerminalId)
		) {
			return { ...view, attachedTerminalId: undefined };
		}
		return view;
	});

	const focusedId = findLeaf(cleaned, blob.focusedId)
		? blob.focusedId
		: (getLeafIdsInOrder(cleaned)[0] ?? '');

	return {
		root: cleaned,
		focusedId,
		closedHistory: (blob.closedHistory ?? []).slice(-MAX_CLOSED_HISTORY),
	};
}

function isStaleOnboardingTab(view: PaneView, dropOnboardingTabs: boolean): boolean {
	if (!dropOnboardingTabs) return false;
	return view.kind === 'route' && view.path.startsWith('/onboarding');
}

function isViewLive(view: PaneView, liveTerminalIds: Set<string>): boolean {
	switch (view.kind) {
		case 'route':
		case 'artifact':
		case 'artifact-studio':
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

/** Walk every view in the tree, transforming each via `fn`. Useful for
 *  metadata sweeps that don't drop tabs (e.g. clearing stale terminal
 *  attachments without removing the Studio tab itself). */
export function mapTreeViews(node: PaneNode, fn: (v: PaneView) => PaneView): PaneNode {
	if (node.type === 'leaf') {
		return { ...node, tabs: node.tabs.map(fn) };
	}
	return { ...node, children: node.children.map((c) => mapTreeViews(c, fn)) };
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

export function flushPaneTreePersist(): void {
	persistDebounced.flush();
}

export async function savePaneTreeNow(snapshot: PaneTreeSnapshot): Promise<void> {
	flushPaneTreePersist();
	await saveLayoutState(STORE_KEY, {
		version: VERSION,
		...snapshot,
	} satisfies PersistedPaneTree);
}
