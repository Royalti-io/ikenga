// Detached-surface tracking for the PRIMARY window (plans/multi-window).
//
// When a pane is popped out (`spawnWindow({ surface_set: ["chat:<id>"] })`),
// its surface is now live in a separate thin window. Without this tracker the
// primary window keeps rendering the same surface too, so the chat / terminal /
// viewer shows up DUPLICATED in both windows (and, for terminal + chat, two
// live views drive the same shared Rust-core session).
//
// The source of truth is the Rust `WindowRegistry`: every spawned window's
// descriptor (with its `surface_set`) is listed by `listWindows()`, and the
// registry broadcasts `window://opened` / `window://closed` whenever the set
// changes. This store seeds from `listWindows()` and re-syncs on each lifecycle
// event, exposing `surfaceId -> hosting window label`. A pane view consults
// `useIsSurfaceDetached(surfaceId)` and, when true, renders a "popped out"
// placeholder instead of the live duplicate.
//
// PRIMARY-WINDOW ONLY. A thin detached window mounts exactly one surface and
// never renders the pop-out-able pane views, so it has nothing to track; the
// initializer no-ops there.

import { WINDOW_TOPICS } from '@ikenga/contract';
import { listen } from '@tauri-apps/api/event';
import { create } from 'zustand';

import { closeWindow, listWindows } from '@/lib/tauri-cmd';
import { isDetachedWindow } from './window-context';

interface DetachedSurfacesState {
	/** `surfaceId` (e.g. `"chat:<threadId>"`) → label of the window hosting it. */
	surfaceToWindow: Record<string, string>;
}

export const useDetachedSurfaces = create<DetachedSurfacesState>(() => ({
	surfaceToWindow: {},
}));

/**
 * Rebuild the surface→window map from the authoritative registry list. Exported
 * as the reconcile path — e.g. after a `spawnWindow` rejection un-does an
 * optimistic `markSurfaceDetached`, since the failed window never lands in the
 * registry list.
 */
export async function syncDetachedSurfaces(): Promise<void> {
	try {
		const windows = await listWindows();
		const map: Record<string, string> = {};
		for (const w of windows) {
			if (w.label === 'main') continue;
			for (const surfaceId of w.surface_set) map[surfaceId] = w.label;
		}
		useDetachedSurfaces.setState({ surfaceToWindow: map });
	} catch (e) {
		console.warn('detached-surfaces: refresh failed', e);
	}
}

let started = false;

/**
 * Seed the tracker and subscribe to the `window://` lifecycle bus. Idempotent;
 * call once from the primary-window bootstrap. No-ops in a detached window.
 *
 * The opened/closed envelopes carry only `{ label, … }`, not the full
 * descriptor, so each event triggers a cheap `listWindows()` re-sync rather
 * than trying to mutate the map from the payload. The primary window may miss
 * its own siblings' very first `opened` event in a race; the initial `refresh()`
 * + optimistic `markSurfaceDetached()` on pop-out cover that window.
 */
export function initDetachedSurfaceTracking(): void {
	if (started || isDetachedWindow()) return;
	started = true;
	void syncDetachedSurfaces();
	void listen(WINDOW_TOPICS.opened, () => void syncDetachedSurfaces());
	void listen(WINDOW_TOPICS.closed, () => void syncDetachedSurfaces());
}

/**
 * Optimistically record a surface as detached the instant pop-out is issued,
 * before the `window://opened` round-trip lands — so the primary pane swaps to
 * its placeholder with no duplicate-render flash. Reconciled by the next
 * `refresh()`.
 */
export function markSurfaceDetached(surfaceId: string, label: string): void {
	useDetachedSurfaces.setState((prev) => ({
		surfaceToWindow: { ...prev.surfaceToWindow, [surfaceId]: label },
	}));
}

/**
 * Reclaim a popped-out surface back into the primary window: close its detached
 * window (the underlying PTY / chat session / file is unaffected — only the thin
 * window goes away) and drop it from the map so the pane re-mounts the live
 * surface inline. Optimistic, with a reconciling `refresh()` on failure.
 */
export async function reclaimSurface(surfaceId: string): Promise<void> {
	const label = useDetachedSurfaces.getState().surfaceToWindow[surfaceId];
	if (!label) return;
	useDetachedSurfaces.setState((prev) => {
		const next = { ...prev.surfaceToWindow };
		delete next[surfaceId];
		return { surfaceToWindow: next };
	});
	try {
		await closeWindow(label);
	} catch (e) {
		console.warn('detached-surfaces: reclaim failed', e);
		void syncDetachedSurfaces();
	}
}

/** Reactive selector — true when `surfaceId` is currently open in a detached window. */
export function useIsSurfaceDetached(surfaceId: string | null | undefined): boolean {
	return useDetachedSurfaces((s) => (surfaceId ? surfaceId in s.surfaceToWindow : false));
}
