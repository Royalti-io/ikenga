// Recently-opened individual artifact files (loupe-level) — per project.
//
// Parallel to `artifact-grid-recents.ts` (which tracks folder grids).
// Recorded automatically when the Studio loupe mounts with a path via
// the `useRecordRecentArtifact` hook. The sidebar's "Recent artifacts"
// section reads this; switching projects shows a different set.
//
// Persisted under `artifact-grid.recent-artifacts.<projectId>` so each
// project carries its own history.

import { useEffect } from 'react';

import { settingsGet, settingsSet } from '@/lib/tauri-cmd';
import { useShellStore } from '@/lib/shell/shell-store';

const KEY_PREFIX = 'artifact-grid.recent-artifacts.';
const CAP = 10;

export interface RecentArtifact {
	path: string;
	openedAtMs: number;
}

function key(projectId: string): string {
	return `${KEY_PREFIX}${projectId}`;
}

// ─── Reactive subscription ───────────────────────────────────────────────

type Listener = (next: RecentArtifact[]) => void;
const listeners: Map<string, Set<Listener>> = new Map();

export function subscribeRecentArtifacts(projectId: string, fn: Listener): () => void {
	let set = listeners.get(projectId);
	if (!set) {
		set = new Set();
		listeners.set(projectId, set);
	}
	set.add(fn);
	return () => {
		set?.delete(fn);
		if (set && set.size === 0) listeners.delete(projectId);
	};
}

function fire(projectId: string, next: RecentArtifact[]): void {
	const set = listeners.get(projectId);
	if (!set) return;
	for (const fn of set) {
		try {
			fn(next);
		} catch (e) {
			console.error('[recent-artifacts] listener threw', e);
		}
	}
}

// ─── Load / mutate ───────────────────────────────────────────────────────

function parse(raw: string | null): RecentArtifact[] {
	if (!raw) return [];
	try {
		const v = JSON.parse(raw);
		if (!Array.isArray(v)) return [];
		return v
			.filter(
				(x): x is RecentArtifact =>
					x &&
					typeof x === 'object' &&
					typeof x.path === 'string' &&
					typeof x.openedAtMs === 'number'
			)
			.slice(0, CAP);
	} catch {
		return [];
	}
}

export async function loadRecentArtifacts(projectId: string): Promise<RecentArtifact[]> {
	const raw = await settingsGet(key(projectId));
	return parse(raw);
}

export async function recordRecentArtifact(
	projectId: string,
	path: string
): Promise<RecentArtifact[]> {
	const cur = await loadRecentArtifacts(projectId);
	const filtered = cur.filter((r) => r.path !== path);
	const next: RecentArtifact[] = [{ path, openedAtMs: Date.now() }, ...filtered].slice(0, CAP);
	await settingsSet(key(projectId), JSON.stringify(next));
	fire(projectId, next);
	return next;
}

export async function removeRecentArtifact(
	projectId: string,
	path: string
): Promise<RecentArtifact[]> {
	const cur = await loadRecentArtifacts(projectId);
	const next = cur.filter((r) => r.path !== path);
	await settingsSet(key(projectId), JSON.stringify(next));
	fire(projectId, next);
	return next;
}

// ─── Hook for the Studio loupe ───────────────────────────────────────────

/** Mount-time recorder. Drop into `StudioLoupe` so every loupe-open is
 *  remembered against the active project. No-op when no active project
 *  or when path is empty (e.g. transient pending-pop states). */
export function useRecordRecentArtifact(path: string): void {
	const activeProjectId = useShellStore((s) => s.activeProjectId);
	useEffect(() => {
		if (!path || !activeProjectId) return;
		void recordRecentArtifact(activeProjectId, path).catch((e) => {
			console.warn('[recent-artifacts] record failed', e);
		});
	}, [path, activeProjectId]);
}
