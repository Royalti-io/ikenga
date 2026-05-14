// Phase 6 — Pane layout per project.
//
// Subscribes to `useShellStore.activeProjectId`. On change:
//   1. Pre-fetch the incoming project's snapshots (pane tree, files
//      explorer, panel sizes) in parallel.
//   2. Flush any pending debounced writes for the outgoing project.
//   3. Save the current state synchronously under the outgoing project's
//      scoped key.
//   4. Apply the incoming snapshots in one tick.
//
// First switch to a project with no saved layout → keep the current
// layout instead of resetting to an empty tree. This matches the plan
// doc's "users start arranging from the current state rather than
// empty" intent.

import { useEffect } from 'react';

import { usePaneStore } from '@/lib/panes/pane-store';
import {
	flushPaneTreePersist,
	loadPaneTree,
	savePaneTreeNow,
} from '@/lib/panes/pane-persistence';
import {
	useFilesStore,
	flushFilesStorePersist,
	loadFilesStateFor,
	saveFilesStoreNow,
	type FilesPersisted,
} from '@/lib/shell/files-store';
import {
	applyPanelSizes,
	flushPanelSizesPersist,
	loadPanelSizes,
} from '@/lib/shell/panel-sizes';
import { useShellStore } from '@/lib/shell/shell-store';

export function useProjectLayoutSwap(): void {
	useEffect(() => {
		// Zustand subscribe with selector + equality fn — fires only when the
		// id actually changes.
		const unsub = useShellStore.subscribe((state, prev) => {
			if (state.activeProjectId === prev.activeProjectId) return;
			void swap(prev.activeProjectId, state.activeProjectId);
		});
		return unsub;
	}, []);
}

/** Exported for testing. */
export async function swapProjectLayout(outgoing: string, incoming: string): Promise<void> {
	return swap(outgoing, incoming);
}

async function swap(outgoing: string, incoming: string): Promise<void> {
	if (outgoing === incoming) return;

	// 1. Pre-fetch incoming. Use a sentinel-aware load so we can tell
	//    "no saved layout" apart from "saved layout that happens to look
	//    empty" — for pane-tree we use the snapshot's focusedId presence
	//    as a proxy (defaultSnapshot always has a focusedId, so non-null
	//    means real or fallback). For files-store and panel-sizes we read
	//    the layout-state row directly via the public load fns; "no row"
	//    returns the fallback, which is fine to apply.
	const [incomingPaneTree, incomingFilesData, incomingPanelSizes] = await Promise.all([
		loadPaneTree(incoming).catch((err) => {
			console.warn('[layout-swap] loadPaneTree(incoming) failed', err);
			return null;
		}),
		loadFilesStateFor(incoming).catch((err) => {
			console.warn('[layout-swap] loadFilesStateFor(incoming) failed', err);
			return EMPTY_PERSISTED;
		}),
		loadPanelSizes(incoming).catch((err) => {
			console.warn('[layout-swap] loadPanelSizes(incoming) failed', err);
			return null;
		}),
	]);

	// 2 + 3. Snapshot outgoing under its own id. Flushes ensure no
	// debounced writes land *after* the swap (which would corrupt the
	// outgoing snapshot).
	flushPaneTreePersist();
	flushFilesStorePersist();
	flushPanelSizesPersist();

	const paneState = usePaneStore.getState();
	const filesSnapshot = useFilesStore.getState().snapshot();

	try {
		await Promise.all([
			savePaneTreeNow(
				{
					root: paneState.root,
					focusedId: paneState.focusedId,
					closedHistory: paneState.closedHistory,
				},
				outgoing
			),
			saveFilesStoreNow(outgoing, filesSnapshot),
			// Panel sizes don't expose their current React-state value to
			// non-React code; instead we just flush whatever the debounce
			// has pending. New sizes captured after the swap will save
			// under `incoming`.
		]);
	} catch (err) {
		console.warn('[layout-swap] save outgoing failed', err);
	}

	// 4. Apply incoming. The plan-doc rule: if no saved layout exists,
	// keep whatever's currently shown. We detect "no saved layout" by
	// comparing the loaded tree against the fresh-default tree shape
	// (single leaf at `/`, empty closedHistory). For panel sizes and
	// files-explorer, applying the fallback is fine — they're cheap to
	// reset and unlikely to confuse the user.
	if (incomingPaneTree && !looksLikeFreshDefault(incomingPaneTree)) {
		usePaneStore.getState().hydrate(incomingPaneTree);
	}
	useFilesStore.getState().applySnapshot(incoming, incomingFilesData);
	if (incomingPanelSizes) {
		applyPanelSizes(incomingPanelSizes);
	}
}

// `loadPaneTree` always returns *something*: either the persisted blob
// or a fresh-default ({ root: leaf('/'), focusedId, closedHistory: [] }).
// A fresh-default for a brand-new project means "no saved layout" — keep
// what the user is currently looking at. Anything else (different
// focusedId, multiple tabs, non-`/` route, history) means real persisted
// state and should be applied.
function looksLikeFreshDefault(
	snapshot: Awaited<ReturnType<typeof loadPaneTree>>
): boolean {
	if (!snapshot) return true;
	if (snapshot.closedHistory.length > 0) return false;
	const root = snapshot.root;
	if (root.type !== 'leaf') return false;
	if (root.tabs.length !== 1) return false;
	const tab = root.tabs[0];
	return tab?.kind === 'route' && tab.path === '/';
}

const EMPTY_PERSISTED: FilesPersisted = {
	expanded: [],
	selectedPath: null,
	scrollTop: 0,
	showHidden: false,
	showIgnored: false,
};
