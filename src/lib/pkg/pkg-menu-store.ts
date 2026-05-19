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
	setMenu: (pkgId, items) =>
		set((s) => ({ menus: { ...s.menus, [pkgId]: items } })),
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
