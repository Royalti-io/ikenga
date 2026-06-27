// Detached surface-host registry (plans/multi-window WP-05 + WP-06).
//
// A detached window mounts exactly the surfaces named in its descriptor's
// `surface_set` (Flavor C = one). This registry is the single seam that maps
// a `surface_id` → { React component, the live-sync event topic }. The
// component is `React.lazy`-loaded so the thin entry only parses the bundle
// for the surface it actually mounts — the performance lever.
//
// WP-06 registers the real `chat` and `viewer` surfaces here.
//
// Surface-set id convention (WP-06):
//   `"chat:<threadId>"` → resolves to the `chat` surface; the component
//   extracts the threadId suffix so the pop-out affordance can encode it.
//   `"viewer:<path>"` → resolves to the `viewer` surface; the component
//   extracts the file path suffix. First-colon split only so absolute paths
//   (e.g. `/home/user/file.md`) survive intact.
//   Plain `"placeholder"` (no colon) → resolve by exact key.
//
// `resolveSurface` checks for an exact key first, then falls back to a
// prefix match (the substring before the first `:`). This keeps the registry
// keys clean ("chat", "viewer") while allowing context to travel in the id.

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
	/** Stable base id — matches the prefix of an entry in `surface_set`. */
	id: string;
	/** Human label for the window chrome / title. */
	title: string;
	/** Lazy body. Default-exports a `ComponentType<DetachedSurfaceProps>`. */
	component: LazyExoticComponent<ComponentType<DetachedSurfaceProps>>;
	/**
	 * Optional Tauri event topic the surface stays in sync over. Documented
	 * here so the substrate, not each surface, owns the wiring. The chat
	 * surface syncs over `chat://session/<id>` (subscribed inside the
	 * component via the shared adapter / Zustand store); the viewer surface
	 * reads files directly and needs no cross-window topic.
	 */
	topic?: string;
}

const SURFACES: Record<string, DetachedSurface> = {
	placeholder: {
		id: 'placeholder',
		title: 'Detached surface',
		component: lazy(() => import('./surfaces/placeholder-surface')),
	},
	// WP-06: real Flavor C surfaces.
	chat: {
		id: 'chat',
		title: 'Chat',
		// The chat://session/<id> event channel is the live-sync topic; the
		// adapter subscribes inside the component (same path as the primary
		// ChatView). Documented here for substrate awareness.
		topic: 'chat://session/*',
		component: lazy(() => import('./surfaces/chat-surface')),
	},
	viewer: {
		id: 'viewer',
		title: 'Viewer',
		component: lazy(() => import('./surfaces/viewer-surface')),
	},
};

/**
 * Resolve a surface by id. Checks for an exact key match first, then falls
 * back to a prefix match (the portion of `id` before the first `:`). This
 * lets `"chat:<threadId>"` and `"viewer:<path>"` resolve to their base
 * surface while the context suffix travels through to the component via
 * `ctx.surfaces[0]`.
 */
export function resolveSurface(id: string): DetachedSurface | undefined {
	if (SURFACES[id]) return SURFACES[id];
	const colon = id.indexOf(':');
	if (colon > 0) {
		return SURFACES[id.slice(0, colon)];
	}
	return undefined;
}

/** Every registered base surface id (for diagnostics / the unknown-surface hint). */
export function registeredSurfaceIds(): string[] {
	return Object.keys(SURFACES);
}
