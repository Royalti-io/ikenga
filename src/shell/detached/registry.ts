// Detached surface-host registry (plans/multi-window WP-05).
//
// A detached window mounts exactly the surfaces named in its descriptor's
// `surface_set` (Flavor C = one). This registry is the single seam that maps
// a `surface_id` → { React component, the live-sync event topic }. The
// component is `React.lazy`-loaded so the thin entry only parses the bundle
// for the surface it actually mounts — the performance lever. WP-06 registers
// the real chat + viewer surfaces here; Phase 1 ships one placeholder that
// proves the thin mount + the cross-window event subscription end-to-end.

import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

import type { WindowContext } from '@/lib/window/window-context';
import type { WindowLifecycleState } from './use-window-lifecycle';

/** Props every detached surface body receives from the thin root. */
export interface DetachedSurfaceProps {
	/** This window's identity (label, kind, surface_set, project binding). */
	ctx: WindowContext;
	/** Live `window://` lifecycle state, subscribed once at the root. */
	lifecycle: WindowLifecycleState;
}

export interface DetachedSurface {
	/** Stable id — matches an entry in the descriptor's `surface_set`. */
	id: string;
	/** Human label for the window chrome / title. */
	title: string;
	/** Lazy body. Default-exports a `ComponentType<DetachedSurfaceProps>`. */
	component: LazyExoticComponent<ComponentType<DetachedSurfaceProps>>;
	/**
	 * Optional Tauri event topic the surface stays in sync over (e.g. a chat
	 * session channel). Documented here so the substrate, not each surface,
	 * owns the wiring as WP-06 lands real surfaces. Unused by the placeholder.
	 */
	topic?: string;
}

const SURFACES: Record<string, DetachedSurface> = {
	placeholder: {
		id: 'placeholder',
		title: 'Detached surface',
		component: lazy(() => import('./surfaces/placeholder-surface')),
	},
};

/** Resolve a surface by id, or undefined if not registered. */
export function resolveSurface(id: string): DetachedSurface | undefined {
	return SURFACES[id];
}

/** Every registered surface id (for diagnostics / the unknown-surface hint). */
export function registeredSurfaceIds(): string[] {
	return Object.keys(SURFACES);
}
