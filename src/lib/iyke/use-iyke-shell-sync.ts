import { useEffect } from 'react';

import { useShellStore } from '@/lib/shell/shell-store';
import { usePaneStore } from '@/lib/panes/pane-store';
import { findLeaf, getLeafIdsInOrder } from '@/lib/panes/pane-reducer';
import type { PaneId, PaneNode, PaneView } from '@/lib/panes/types';

import { setShell } from './client';
import { getIframe, IFRAME_STATE_EVENT } from './iframe-registry';

/**
 * Bridge between React shell state and the Iyke Rust mirror. Mounted
 * once inside `<Workspace />` — i.e. only at the global, post-auth
 * level, never inside a pane's memory router.
 *
 * Pushes the active sidebar mode + focused pane's route + a flat
 * leaves-and-tree pane snapshot. Failures are logged, not thrown —
 * Iyke isn't on the user's critical path.
 */
export function useIykeShellSync(): void {
	const activeMode = useShellStore((s) => s.activeMode);
	// Re-fire when focused pane changes or when the tree mutates (any
	// navigation inside a pane updates `root` immutably via the reducer).
	const focusedId = usePaneStore((s) => s.focusedId);
	const root = usePaneStore((s) => s.root);

	useEffect(() => {
		pushShellState();
	}, [activeMode, focusedId, root]);

	// Re-push when a pkg iframe publishes state (selection etc.) so
	// `iyke state` reflects it without waiting for a pane-tree mutation.
	useEffect(() => {
		const onState = () => pushShellState();
		window.addEventListener(IFRAME_STATE_EVENT, onState);
		return () => window.removeEventListener(IFRAME_STATE_EVENT, onState);
	}, []);
}

function pushShellState(): void {
	const activeMode = useShellStore.getState().activeMode;
	const paneState = usePaneStore.getState();
	const view = paneState.focusedView();
	const route = view && view.kind === 'route' ? view.path : null;
	const panes = buildPanesPayload(paneState.root, paneState.focusedId);
	setShell({ mode: activeMode, route, panes }).catch((err) => {
		console.warn('[iyke] set_shell failed:', err);
	});
}

interface LeafSummary {
	id: string;
	focused: boolean;
	activeTabIdx: number;
	tabs: Array<{ kind: string; title: string; pinned?: boolean }>;
	/** Pkg id when the active tab is a /pkg/<id>/ route. */
	pkg?: string;
	/** Latest state the pkg iframe published (e.g. open-task selection). */
	state?: Record<string, unknown>;
}

interface PanesPayload {
	leaves: LeafSummary[];
	tree: PaneNode;
}

function buildPanesPayload(root: PaneNode, focusedId: PaneId): PanesPayload {
	const ids = getLeafIdsInOrder(root);
	const leaves: LeafSummary[] = ids.map((id) => {
		const leaf = findLeaf(root, id);
		if (!leaf) {
			// Defensive — getLeafIdsInOrder pulled this id from the same
			// tree, so findLeaf should always succeed.
			return { id, focused: false, activeTabIdx: 0, tabs: [] };
		}
		const summary: LeafSummary = {
			id,
			focused: id === focusedId,
			activeTabIdx: leaf.activeTabIdx,
			tabs: leaf.tabs.map((t) => ({
				kind: t.kind,
				title: viewTitle(t),
				...(t.pinned ? { pinned: true } : {}),
			})),
		};
		// Surface the pkg id + its latest published state (selection etc.) for
		// pkg-route panes, so external callers can answer "what's open in this
		// pane" from `iyke state` alone. Pkg iframes register by pkg id —
		// see pkg-iframe-host.tsx Step 1c.
		const active = leaf.tabs[leaf.activeTabIdx];
		if (active?.kind === 'route') {
			const m = /^\/pkg\/([^/]+)/.exec(active.path);
			if (m) {
				summary.pkg = m[1];
				const reg = getIframe(m[1]);
				if (reg && Object.keys(reg.state).length > 0) summary.state = reg.state;
			}
		}
		return summary;
	});
	return { leaves, tree: root };
}

function viewTitle(view: PaneView): string {
	switch (view.kind) {
		case 'route':
			return view.path;
		case 'terminal':
		case 'chat':
			return view.sessionId;
		case 'artifact':
			return view.path;
		case 'artifact-studio':
			return 'artifact-studio';
		case 'scratchpad':
			return `${view.scope}/${view.name}`;
		case 'tool-output':
			return `tool-output:${view.toolUseId}`;
	}
}
