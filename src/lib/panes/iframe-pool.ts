// Hoisted iframe pool — the state layer behind the "pkg iframes survive tab
// switch / reorder / split / pane-tree rebuild" fix (plans/studio/17-deep-
// review §1 remedy 2).
//
// THE PROBLEM. `PaneBody` renders only the active tab, keyed by the tab's
// identity (`pane.tsx`). Any tab switch, reorder, split, or PanelGroup rebuild
// unmounts that subtree — and with it the inline `<iframe srcDoc>` that
// `PkgIframeHost` owns, discarding the entire iframe JS heap. On remount the
// pkg cold-starts (fresh token, AppBridge re-handshake). For Studio that reads
// as a full "restart" on every pane switch.
//
// THE FIX. The actual `<iframe>` elements live in a singleton `<PkgIframeLayer>`
// mounted ONCE near the workspace root — outside the pane tree and outside the
// PanelGroup remount scope — so they are never unmounted by a pane-layer
// change. The in-pane component becomes a thin *placeholder* that (a) claims a
// surface here, (b) reports its content rect + visibility, and (c) on unmount
// merely *releases* the claim (never tears the iframe down). The layer floats
// each iframe (`position:fixed`) over its claimed rect. This module is the
// shared registry the placeholder writes and the layer reads.
//
// SURFACE KEY. `pkgId :: source :: tabUid`. tabUid is the reducer's stable
// per-tab identity (survives reorder/close/split; carried forward on same-slot
// content swaps). Keying on it means: the same tab switched away and back
// reclaims the SAME live iframe; the same pkg open in two tabs/panes gets two
// distinct iframes (distinct tabUids); and navigating one tab from pkg A to
// pkg B in place (tabUid carried, pkgId/source changed) correctly mints a NEW
// surface rather than reusing the wrong iframe.
//
// LIFECYCLE. A claimed surface is visible + interactive. A released surface is
// kept alive but hidden (keep-alive) up to `MAX_HIDDEN`; beyond that the
// least-recently-active hidden surface is EVICTED — dropped from the map, which
// unmounts its layer entry and runs the full teardown (bridge.close +
// pkg_content_revoke + element removal). A surface whose owning tab no longer
// exists in the tree (closed / moved) is pruned immediately (see `release` +
// the pane-store subscription below) rather than waiting for LRU pressure.

import { create } from 'zustand';
import { findLeaf, getLeafIdsInOrder, tabUid } from './pane-reducer';
import { usePaneStore } from './pane-store';

/** Viewport-client rect (getBoundingClientRect, rounded) the layer floats the
 *  iframe over. `position:fixed` uses these coords directly on the single-window
 *  shell. */
export interface PoolRect {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface PoolSurface {
	/** `pkgId :: source :: tabUid`. */
	key: string;
	pkgId: string;
	source: string;
	/** Owning pane id — the layer routes iframe focus back to this pane. */
	paneId: string;
	/** Owning tab's stable identity — liveness is checked against this. */
	tabUid: string;
	/** Latest measured content rect, or null before the first measure. */
	rect: PoolRect | null;
	/** True while an in-pane placeholder is mounted for this surface (visible +
	 *  interactive). False once released (hidden keep-alive). */
	claimed: boolean;
	/** Wall-clock of the last claim/release — the LRU eviction key. */
	lastActiveAt: number;
	/** Mirrors the owning tab's pane's `refreshTicks[paneId]` at the last claim.
	 *  The layer threads this into the pooled `PkgIframeHostInner` as an extra
	 *  fetch-effect dependency (alongside its dev-mode `reloadKey`) so the
	 *  toolbar refresh button — which remounts the in-pane placeholder without
	 *  changing `key` (identity stays `pkgId::source::tabUid`, deliberately, so
	 *  the SAME live surface is reclaimed rather than orphaned) — still forces a
	 *  real reboot of the iframe content instead of being a silent no-op. */
	refreshTick: number;
}

// Max hidden (released-but-alive) surfaces kept for instant reclaim before LRU
// eviction kicks in. Studio + a handful of other pkgs open at once fit under
// this; beyond it the memory/compositor cost of retained iframes isn't worth
// the reclaim speed.
const MAX_HIDDEN = 4;

/** Module-const flag, overridable per-session via `localStorage.ikenga.iframePool`
 *  (`'0'` forces the legacy inline path, `'1'` forces the pool). DEFAULT ON in
 *  dev and prod so live-verify can flip it at runtime (reload) without a
 *  rebuild. Read once at module load so behavior is stable within a session. */
function readPoolFlag(): boolean {
	try {
		const v = localStorage.getItem('ikenga.iframePool');
		if (v === '0') return false;
		if (v === '1') return true;
	} catch {
		// no localStorage (SSR / locked-down env) — fall through to default
	}
	return true;
}

export const IFRAME_POOL_ENABLED = readPoolFlag();

export function poolSurfaceKey(pkgId: string, source: string, tabId: string): string {
	return `${pkgId}::${source}::${tabId}`;
}

/** Tracing-style debug for claim/release/evict, gated on the flag so the legacy
 *  path stays silent. Flip DevTools console to "Verbose" to see them. */
function dbg(...args: unknown[]): void {
	if (IFRAME_POOL_ENABLED) console.debug('[iframe-pool]', ...args);
}

/** Every tabUid currently present anywhere in the pane tree. A surface whose
 *  tabUid isn't in here is orphaned (its tab was closed or moved) and safe to
 *  evict. */
function liveTabUids(): Set<string> {
	const live = new Set<string>();
	const { root } = usePaneStore.getState();
	for (const paneId of getLeafIdsInOrder(root)) {
		const leaf = findLeaf(root, paneId);
		if (!leaf) continue;
		for (const view of leaf.tabs) live.add(tabUid(view));
	}
	return live;
}

interface ClaimInfo {
	pkgId: string;
	source: string;
	paneId: string;
	tabUid: string;
	rect: PoolRect | null;
	/** Current `refreshTicks[paneId]` — see `PoolSurface.refreshTick`. */
	refreshTick: number;
}

interface IframePoolState {
	surfaces: Record<string, PoolSurface>;
	/** Placeholder mounted: create-or-reclaim the surface, mark it visible. */
	claim: (key: string, info: ClaimInfo) => void;
	/** Placeholder measured a new rect. No-op if the surface is gone. */
	updateRect: (key: string, rect: PoolRect) => void;
	/** Placeholder unmounted: mark hidden, prune orphans, then LRU-evict. */
	release: (key: string) => void;
	/** Prune hidden surfaces whose tab no longer exists (called on pane-tree
	 *  changes). Never touches claimed surfaces — their placeholder owns them. */
	pruneOrphans: () => void;
}

export const useIframePool = create<IframePoolState>((set) => ({
	surfaces: {},

	claim: (key, info) =>
		set((s) => {
			const prev = s.surfaces[key];
			dbg('claim', key, prev ? '(reclaim)' : '(new)');
			const next: PoolSurface = {
				key,
				pkgId: info.pkgId,
				source: info.source,
				paneId: info.paneId,
				tabUid: info.tabUid,
				// Keep the last known rect on reclaim if the new measure is null
				// (placeholder hasn't laid out yet) so the iframe doesn't flash to
				// zero-size before its first flush.
				rect: info.rect ?? prev?.rect ?? null,
				claimed: true,
				lastActiveAt: Date.now(),
				refreshTick: info.refreshTick,
			};
			return { surfaces: { ...s.surfaces, [key]: next } };
		}),

	updateRect: (key, rect) =>
		set((s) => {
			const prev = s.surfaces[key];
			if (!prev) return s;
			return { surfaces: { ...s.surfaces, [key]: { ...prev, rect } } };
		}),

	release: (key) =>
		set((s) => {
			const prev = s.surfaces[key];
			if (!prev) return s;
			dbg('release', key);
			const surfaces = {
				...s.surfaces,
				[key]: { ...prev, claimed: false, lastActiveAt: Date.now() },
			};
			// 1) Prune orphans first — a just-closed tab's surface should die now,
			//    not linger until LRU pressure. (The pane-store subscription can't
			//    catch it: at subscription-fire time this surface is still claimed
			//    because the placeholder's unmount cleanup — this very call — runs
			//    only after React commits the tree change.)
			const live = liveTabUids();
			for (const k of Object.keys(surfaces)) {
				const surf = surfaces[k];
				if (!surf.claimed && !live.has(surf.tabUid)) {
					dbg('evict(orphan)', k);
					delete surfaces[k];
				}
			}
			// 2) LRU-evict remaining hidden surfaces beyond the cap.
			const hidden = Object.values(surfaces)
				.filter((x) => !x.claimed)
				.sort((a, b) => a.lastActiveAt - b.lastActiveAt);
			for (let i = 0; i < hidden.length - MAX_HIDDEN; i++) {
				dbg('evict(lru)', hidden[i].key);
				delete surfaces[hidden[i].key];
			}
			return { surfaces };
		}),

	pruneOrphans: () =>
		set((s) => {
			const live = liveTabUids();
			let changed = false;
			const surfaces = { ...s.surfaces };
			for (const key of Object.keys(surfaces)) {
				const surf = surfaces[key];
				if (!surf.claimed && !live.has(surf.tabUid)) {
					dbg('evict(orphan)', key);
					delete surfaces[key];
					changed = true;
				}
			}
			return changed ? { surfaces } : s;
		}),
}));

// Prune orphaned surfaces whenever the pane tree changes (a tab closed or moved
// out from under a hidden surface). Mirrors route-view's router-cache eviction.
// Only meaningful when pooling is on; harmless (empty map) otherwise.
if (IFRAME_POOL_ENABLED) {
	usePaneStore.subscribe(() => useIframePool.getState().pruneOrphans());
}
