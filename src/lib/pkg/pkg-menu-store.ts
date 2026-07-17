// Pkg menu store — runtime sidebar items published by pkg iframes via the
// `host.pkg.setMenu` host tool. The shell renders these in the App-mode
// sidebar when the focused pane is on a pkg route. Item clicks publish the
// new active feature back to the iframe via a hostContext update (custom
// `royaltiSuite.activeFeature` field).
//
// The pkg's iframe owns its routing — this store is just a relay for the
// shell to render and click. Pkgs can call setMenu() any time after their
// AppBridge handshake is complete (e.g. to update badge counts).

import { create } from 'zustand';

export interface PkgMenuItem {
	id: string;
	label: string;
	icon?: string | null;
	badge?: string | number | null;
	/** Two-line context header (the locked M-A "production ledger" rail): the
	 *  presence of this key — even as `null` — promotes the item from a nav row
	 *  to a static header, `label` bright over `subtitle` in mono. A header is
	 *  not a disabled nav row: it never dims, never highlights, never fires, and
	 *  drops `icon` / `badge` (the meta line carries that context instead).
	 *  `null` renders the label alone, so a pkg with no loaded meta shows an
	 *  honest single line rather than an invented one. Older shells ignore the
	 *  key and render the plain row, so pkgs can adopt it unpinned. */
	subtitle?: string | null;
	/** Optional group label. Consecutive items sharing the same `section` render
	 *  under one heading; items with no `section` form the implicit first group.
	 *  Order is preserved as published — the shell does not re-sort. */
	section?: string | null;
	/** When true, the item renders dimmed and is non-interactive (no click, no
	 *  active-feature update). Pkgs use this to keep an item visible-but-inert
	 *  when it doesn't apply to the current state (e.g. list filters while a
	 *  non-list view is active) — mirrors Ngwa's "Kind dims on Analyze". */
	disabled?: boolean;
	/** Explicit active-highlight, pkg-driven. When set, it overrides the
	 *  store's last-clicked `activeFeature` for this item — lets a pkg show two
	 *  independent selections at once (e.g. the active view AND the active
	 *  filter). When `undefined`, the shell falls back to `id === activeFeature`. */
	active?: boolean;
	/** Segmented view-switcher (the locked `list-kanban-switch` pattern): when
	 *  `kind === 'seg'` the item renders as an inline `Segmented` pill strip
	 *  instead of a nav row. Each option is a mini-item — clicking one sets the
	 *  pkg's activeFeature to the OPTION's id, so pkgs publish full feature ids
	 *  (e.g. `seg:list` / `seg:kanban`). `label` is unused on seg items. */
	kind?: 'item' | 'seg';
	options?: Array<{ id: string; label: string; active?: boolean }>;
}

interface PkgMenuState {
	/** pkg_id → menu items, last-published. */
	menus: Record<string, PkgMenuItem[]>;
	/** pkg_id → currently-active feature id (last clicked from the sidebar). */
	activeFeatures: Record<string, string>;
	setMenu: (pkgId: string, items: PkgMenuItem[]) => void;
	clearMenu: (pkgId: string) => void;
	setActiveFeature: (pkgId: string, featureId: string) => void;
}

export const usePkgMenuStore = create<PkgMenuState>((set) => ({
	menus: {},
	activeFeatures: {},
	setMenu: (pkgId, items) => set((s) => ({ menus: { ...s.menus, [pkgId]: items } })),
	clearMenu: (pkgId) =>
		set((s) => {
			const next = { ...s.menus };
			delete next[pkgId];
			return { menus: next };
		}),
	setActiveFeature: (pkgId, featureId) =>
		set((s) => ({ activeFeatures: { ...s.activeFeatures, [pkgId]: featureId } })),
}));

/** Parse a pkg route like `/pkg/com.example.foo/sub/path` and return its pkg id.
 *  Returns null for non-pkg routes. */
export function pkgIdFromRoute(route: string | null | undefined): string | null {
	if (!route) return null;
	const m = route.match(/^\/pkg\/([^/]+)/);
	return m ? m[1]! : null;
}
