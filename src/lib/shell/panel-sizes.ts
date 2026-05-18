// Workspace panel-sizes persistence.
//
// Sizes are stored as [sidebar, content] in the SQLite `layout_state` kv
// at key `workspace.panels` (one global key — panel sizes used to be
// project-scoped via the layout-swap orchestrator, but project switch is
// no longer a layout event).

import { debounce, loadLayoutState, saveLayoutState } from '@/lib/layout-state';

export const PANEL_SIZES_KEY = 'workspace.panels';
export const DEFAULT_PANEL_SIZES: [number, number] = [16, 84];

const persist = debounce((sizes: [number, number]) => {
	void saveLayoutState(PANEL_SIZES_KEY, sizes);
}, 500);

export function persistPanelSizes(sizes: number[]): void {
	if (sizes.length !== 2) return;
	persist([sizes[0]!, sizes[1]!]);
}

export function flushPanelSizesPersist(): void {
	persist.flush();
}

export async function savePanelSizesNow(sizes: [number, number]): Promise<void> {
	persist.flush();
	await saveLayoutState(PANEL_SIZES_KEY, sizes);
}

export async function loadPanelSizes(): Promise<[number, number]> {
	const sizes = await loadLayoutState<[number, number]>(PANEL_SIZES_KEY, DEFAULT_PANEL_SIZES);
	// Migrate old 3-tuple persisted layouts (sidebar/content/sidepane).
	return (sizes as unknown as number[]).length === 2
		? (sizes as [number, number])
		: DEFAULT_PANEL_SIZES;
}

// Setter registered by the `Workspace` component. Kept around because the
// settings "Reset layout" surface can still push a fresh default back into
// React state without remounting the panels.
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
