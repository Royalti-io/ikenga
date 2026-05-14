// Workspace panel-sizes persistence — extracted so the project-layout-swap
// orchestrator can save/load/flush without prop-drilling through React.
//
// Sizes are stored as [sidebar, content] in the SQLite `layout_state` kv
// at key `workspace.panels.${projectId}`. The setter callback (registered
// by `Workspace` on mount) is how the swap orchestrator applies a
// project's saved sizes back into React state.

import {
	debounce,
	deleteScopedLayoutState,
	migrateLegacyKey,
	saveScopedLayoutState,
} from '@/lib/layout-state';

export const PANEL_SIZES_KEY = 'workspace.panels';
export const DEFAULT_PANEL_SIZES: [number, number] = [16, 84];

const persist = debounce((projectId: string, sizes: [number, number]) => {
	void saveScopedLayoutState(PANEL_SIZES_KEY, projectId, sizes);
}, 500);

export function persistPanelSizes(projectId: string, sizes: number[]): void {
	if (sizes.length !== 2) return;
	persist(projectId, [sizes[0]!, sizes[1]!]);
}

export function flushPanelSizesPersist(): void {
	persist.flush();
}

export async function savePanelSizesNow(
	projectId: string,
	sizes: [number, number]
): Promise<void> {
	persist.flush();
	await saveScopedLayoutState(PANEL_SIZES_KEY, projectId, sizes);
}

export async function loadPanelSizes(projectId: string): Promise<[number, number]> {
	const sizes = await migrateLegacyKey<[number, number]>(
		PANEL_SIZES_KEY,
		projectId,
		DEFAULT_PANEL_SIZES
	);
	// Migrate old 3-tuple persisted layouts (sidebar/content/sidepane).
	return (sizes as unknown as number[]).length === 2
		? (sizes as [number, number])
		: DEFAULT_PANEL_SIZES;
}

export async function resetPanelSizes(projectId: string): Promise<void> {
	await deleteScopedLayoutState(PANEL_SIZES_KEY, projectId);
}

// Setter registered by the `Workspace` component. Set on mount, cleared
// on unmount. The swap orchestrator uses it to push a loaded snapshot
// into React without going through the component itself.
let setter: ((sizes: [number, number]) => void) | null = null;
export function registerPanelSizesSetter(fn: (sizes: [number, number]) => void): () => void {
	setter = fn;
	return () => {
		if (setter === fn) setter = null;
	};
}
export function applyPanelSizes(sizes: [number, number]): void {
	if (setter) setter(sizes);
}
