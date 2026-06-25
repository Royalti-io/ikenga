// Typed client for the `/iyke/browser/*` chrome-attach picker verbs.
//
// These talk to the shell-side bridge (which reverse-proxies to the Playwright
// sidecar) over the same bearer-token contract as every other iyke client.
// Scope is the attach-picker surface: enumerate OS Chrome profiles, probe the
// live CDP targets, launch a chosen profile in debug mode, and open a pane with
// an explicit attach target. The full pane-driving verb set (snapshot/click/…)
// is owned by the pkg-browser MCP server, not the shell FE.

import { iykeFetch } from './client';

/** An OS Chrome profile on disk (from the user-data-dir's `Local State`). */
export interface BrowserProfile {
	/** Profile directory name (`Default`, `Profile 1`, …). */
	dir: string;
	/** Display name from `profile.info_cache`. */
	name: string;
	/** Best-effort: is this profile currently running (singleton lock / live pid). */
	running: boolean;
}

/** A live tab/window in a running debug Chrome (raw CDP `/json`). */
export interface BrowserTarget {
	targetId: string;
	title: string;
	url: string;
	kind: string;
}

export interface BrowserProfilesResult {
	profiles: BrowserProfile[];
}

export interface BrowserTargetsResult {
	/** The reachable CDP endpoint, or `null` when no debug Chrome is up. */
	endpoint: string | null;
	targets: BrowserTarget[];
}

export interface BrowserLaunchProfileResult {
	ok: boolean;
	endpoint: string;
}

/** Attach-mode target selection forwarded to the sidecar on `open`. */
export type AttachTarget = 'new' | 'active' | (string & {});

export interface BrowserOpenBody {
	pkg_id: string;
	pane_id: string;
	url: string;
	partition?: string;
	engine?: string;
	mode?: string;
	attach_target?: AttachTarget;
}

async function jsonOrThrow<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await iykeFetch(path, init);
	if (!res.ok) {
		const detail = await res.text().catch(() => res.statusText);
		throw new Error(`iyke ${path} ${res.status}: ${detail}`);
	}
	return (await res.json()) as T;
}

/** OS Chrome profiles on disk (NOT the Ikenga named partitions). */
export function browserProfiles(): Promise<BrowserProfilesResult> {
	return jsonOrThrow<BrowserProfilesResult>('/iyke/browser/profiles');
}

/** Live tabs/windows of a running debug Chrome; `endpoint: null` if none is up. */
export function browserTargets(): Promise<BrowserTargetsResult> {
	return jsonOrThrow<BrowserTargetsResult>('/iyke/browser/targets');
}

/** Launch the installed Chrome for `dir` with a remote-debugging port. */
export function browserLaunchProfile(
	dir: string,
	port?: number
): Promise<BrowserLaunchProfileResult> {
	return jsonOrThrow<BrowserLaunchProfileResult>('/iyke/browser/launch_profile', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ dir, ...(port != null ? { port } : {}) }),
	});
}

/** Open a browser pane (chrome attach mode honors `attach_target`). */
export function browserOpen(body: BrowserOpenBody): Promise<unknown> {
	return jsonOrThrow<unknown>('/iyke/browser/open', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});
}
