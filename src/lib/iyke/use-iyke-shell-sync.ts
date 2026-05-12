import { useEffect } from 'react';

import { useShellStore } from '@/lib/shell/shell-store';
import { usePaneStore } from '@/lib/panes/pane-store';
import { findLeaf, getLeafIdsInOrder } from '@/lib/panes/pane-reducer';
import type { PaneId, PaneNode, PaneView } from '@/lib/panes/types';

import { setShell } from './client';

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
		const view = usePaneStore.getState().focusedView();
		const route = view && view.kind === 'route' ? view.path : null;
		const panes = buildPanesPayload(root, focusedId);
		setShell({ mode: activeMode, route, panes }).catch((err) => {
			console.warn('[iyke] set_shell failed:', err);
		});
	}, [activeMode, focusedId, root]);
}

interface LeafSummary {
	id: string;
	focused: boolean;
	activeTabIdx: number;
	tabs: Array<{ kind: string; title: string; pinned?: boolean }>;
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
		return {
			id,
			focused: id === focusedId,
			activeTabIdx: leaf.activeTabIdx,
			tabs: leaf.tabs.map((t) => ({
				kind: t.kind,
				title: viewTitle(t),
				...(t.pinned ? { pinned: true } : {}),
			})),
		};
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
	}
}
