// Per-window identity, derived once from the spawn URL (plans/multi-window
// WP-05). `WindowRegistry::spawn` (Rust, WP-03) builds every non-primary
// window with `?window=<label>&kind=<kind>&surfaces=<csv>&project=<id>`
// appended to the same app URL as `main`. The primary window carries no such
// params, so it resolves to label `"main"` / kind `"primary"`.
//
// This is the thin-entry's first read: `main.tsx` branches on `isDetached`
// to mount the thin surface-host instead of the full workspace, and the
// persisted-store helpers below namespace localStorage by window label so a
// detached window can't clobber the primary's UI state (research 03 — same
// origin shares localStorage across all Tauri windows).

import type { WindowKind } from '@ikenga/contract';

export interface WindowContext {
	/** OS window label. `"main"` for the primary; `"detached-<n>"` otherwise. */
	label: string;
	/** Window kind from the descriptor (`primary` for the unparameterised main). */
	kind: WindowKind;
	/** Surface/route ids this window's entry should mount (from `surface_set`). */
	surfaces: string[];
	/** Project binding, or null when the window follows the primary. */
	projectId: string | null;
	/** True for any non-`main` window — the thin detached path. */
	isDetached: boolean;
}

const VALID_KINDS: readonly WindowKind[] = ['primary', 'single-surface', 'pane-set', 'workspace'];

function parse(): WindowContext {
	// Guard for non-browser contexts (vitest pure-logic, SSR) — no params →
	// the primary window, so existing persisted keys stay byte-identical.
	if (typeof location === 'undefined') {
		return { label: 'main', kind: 'primary', surfaces: [], projectId: null, isDetached: false };
	}
	const params = new URLSearchParams(location.search);
	const label = params.get('window') ?? 'main';
	const rawKind = params.get('kind');
	const kind: WindowKind =
		rawKind && (VALID_KINDS as readonly string[]).includes(rawKind)
			? (rawKind as WindowKind)
			: 'primary';
	// One repeated `surfaces` param per entry (registry.rs appends them that
	// way) — NOT a comma-joined CSV: a surface id can contain a comma (e.g.
	// `viewer:/a/b,c.md`), which a comma-split would fracture.
	const surfaces = params.getAll('surfaces').map((s) => s.trim()).filter(Boolean);
	const projectId = params.get('project');
	return {
		label,
		kind,
		surfaces,
		projectId: projectId && projectId.length > 0 ? projectId : null,
		isDetached: label !== 'main',
	};
}

let cached: WindowContext | null = null;

/** The window's identity, parsed once from the spawn URL and memoised. */
export function windowContext(): WindowContext {
	if (!cached) cached = parse();
	return cached;
}

/** This window's OS label (`"main"` for the primary). */
export function windowLabel(): string {
	return windowContext().label;
}

/** True when this is a thin detached (non-`main`) window. */
export function isDetachedWindow(): boolean {
	return windowContext().isDetached;
}

/**
 * Namespace a Zustand `persist()` key by window label. The primary `main`
 * window keeps the bare key (so every existing persisted blob — theme,
 * onboarding, snooze — survives), while a detached window gets a `::<label>`
 * suffix so its writes land in a separate localStorage slot and never clobber
 * the primary's UI state.
 */
export function scopedPersistName(base: string): string {
	const label = windowLabel();
	return label === 'main' ? base : `${base}::${label}`;
}

/**
 * Namespace the layout-state localStorage prefix (`"__lstate__:"`) by window
 * label, same rationale as {@link scopedPersistName}. The primary keeps the
 * bare prefix; a detached window inserts its label before the trailing colon
 * (`"__lstate__:detached-1:"`). The SQLite copy is keyed separately via
 * {@link scopedPersistName}'s sibling in `layout-state.ts` (`scopedKey`).
 */
export function scopedLsPrefix(base: string): string {
	const label = windowLabel();
	return label === 'main' ? base : `${base}${label}:`;
}
