// Ikenga artifact bridge — host-injected runtime polyfill.
//
// What this is:
//   The viewer-server (`src-tauri/src/viewer_server/mod.rs`) injects the
//   bundled output of this module into every served Ikenga artifact's
//   <head>. It populates two window globals before the artifact's own
//   inline polyfill (if any) runs:
//
//     window.__ikenga_host__         — host descriptor; presence signals
//                                      "you're running inside Ikenga".
//     window.__ikenga_bridge_polyfill__.init()
//                                    — returns a Promise<Art> that the
//                                      artifact's React code awaits.
//
// Shape contract: mirrors the inline polyfill in
//   ikenga-artifact-builder/skills/ikenga-artifact-builder/references/hello-world.html
// expanded to cover the full surface in that skill's SKILL.md
// ("Bridge surface (cheat sheet)" section).
//
// v0 scope: fetch sources do real network calls with mock fallback;
// supabase/sql/mcp/file sources resolve directly to mock; notes/pin are
// console stubs. Phase 2 replaces the non-fetch resolvers with host RPC.
//
// Theme: `setupTheme()` mirrors the shell's `data-mode`/`data-theme`/
// `data-density` (+ a `.dark` class) onto the artifact's own `<html>` and
// re-applies live on every toggle; standalone it follows `prefers-color-
// scheme`. Exposed to artifact code as `art.theme`. The inline polyfill in
// the skill template carries only the standalone half (OS color scheme).
//
// Constraints (do not violate without updating bridge.entry.ts comment):
//   - Pure browser-side. No Node/Tauri imports. Runs in an iframe.
//   - No top-level await — must survive Babel-standalone compilation.
//   - No external imports. Re-declare types inline.
//   - Strict TypeScript.

// ── Types (inline; mirrors @ikenga/contract manifest shape minimally) ────

type RefreshMode = 'manual' | 'interval' | 'watch';

interface RefreshConfig {
	mode?: RefreshMode;
	every?: string;
	onFocus?: boolean;
}

interface FetchSource {
	type: 'fetch';
	url: string;
	method?: string;
	headers?: Record<string, string>;
	refresh?: RefreshConfig;
}

interface OtherSource {
	type: 'supabase' | 'sql' | 'mcp' | 'file';
	refresh?: RefreshConfig;
	[key: string]: unknown;
}

type DataSource = FetchSource | OtherSource;

interface Manifest {
	id: string;
	dataSources?: Record<string, DataSource>;
	[key: string]: unknown;
}

interface HostDescriptor {
	kind: 'ikenga' | 'browser';
	user: null;
}

interface SourceHandle {
	get: () => unknown;
	subscribe: (fn: (value: unknown) => void) => () => void;
	refresh: () => Promise<void>;
}

interface StateHandle {
	get: (key: string) => unknown;
	set: (key: string, value: unknown) => void;
	subscribe: (key: string, fn: (value: unknown) => void) => () => void;
}

interface NotesHandle {
	send: (text: string, opts?: Record<string, unknown>) => void;
}

type ThemeMode = 'light' | 'dark';

interface ThemeSnapshot {
	mode: ThemeMode;
	/** Palette variant — 'A' | 'B' | 'C' (or a custom theme id). */
	theme: string;
	density: string;
}

/**
 * Live view of the host theme. Reads track the current value; `subscribe`
 * fires on every shell toggle (or OS color-scheme change when standalone).
 */
interface ThemeHandle {
	readonly mode: ThemeMode;
	readonly theme: string;
	readonly density: string;
	subscribe: (fn: (t: ThemeSnapshot) => void) => () => void;
}

interface Art {
	manifest: Manifest;
	host: {
		kind: 'ikenga' | 'browser';
		user: null;
		usedFallback: (name: string) => boolean;
		anyFallback: () => boolean;
	};
	source: (name: string) => SourceHandle;
	state: StateHandle;
	notes: NotesHandle;
	theme: ThemeHandle;
	pin: () => void;
}

interface BridgePolyfill {
	init: () => Promise<Art>;
}

declare global {
	interface Window {
		__ikenga_host__?: HostDescriptor;
		__ikenga_bridge_polyfill__?: BridgePolyfill;
	}
}

// ── Helpers ──────────────────────────────────────────────────────────────

function parseTagJson<T>(id: string): T | null {
	const el = document.getElementById(id);
	if (!el?.textContent) return null;
	try {
		return JSON.parse(el.textContent) as T;
	} catch {
		return null;
	}
}

/**
 * Parse a duration string like "30s", "15m", "1h", "2d" → ms.
 * Returns null if the string is malformed.
 */
function parseDuration(s: string | undefined): number | null {
	if (!s) return null;
	const match = /^(\d+)\s*([smhd])$/.exec(s.trim());
	if (!match) return null;
	const n = Number(match[1]);
	switch (match[2]) {
		case 's':
			return n * 1000;
		case 'm':
			return n * 60_000;
		case 'h':
			return n * 3_600_000;
		case 'd':
			return n * 86_400_000;
		default:
			return null;
	}
}

// ── Theme mirroring ────────────────────────────────────────────────────────

/**
 * Make the artifact follow the host theme.
 *
 * Inside the shell the artifact iframe is same-origin with the shell (the
 * viewer-server serves it from the shell's own origin), so we read the live
 * `data-mode` / `data-theme` / `data-density` attributes the shell writes on
 * its `<html>` (see `lib/ikenga/theme-store.ts`) and mirror them onto the
 * artifact's own `<html>`. `@ikenga/tokens` is pre-injected by the viewer
 * server, so its `:root[data-mode=…]` / `[data-theme=…][data-mode=…]`
 * selectors resolve once the attributes are present. We also toggle a `.dark`
 * class so Tailwind's class-strategy dark mode tracks the shell.
 *
 * A `MutationObserver` on the shell's `<html>` re-applies on every toggle —
 * the live-switch path. Outside the shell (`window.parent` is self or throws
 * cross-origin) we fall back to the OS `prefers-color-scheme` and follow it
 * live; the palette defaults to 'A'.
 *
 * Runs synchronously in `<head>` (the bridge is the first, non-deferred
 * script), so the first paint is already themed — no flash.
 */
function setupTheme(): ThemeHandle {
	const subs: Array<(t: ThemeSnapshot) => void> = [];
	let current: ThemeSnapshot = { mode: 'dark', theme: 'A', density: 'comfortable' };

	function apply(next: ThemeSnapshot): void {
		current = next;
		const html = document.documentElement;
		html.setAttribute('data-mode', next.mode);
		html.setAttribute('data-theme', next.theme);
		html.setAttribute('data-density', next.density);
		html.classList.toggle('dark', next.mode === 'dark');
		for (const fn of subs.slice()) {
			try {
				fn(next);
			} catch (err) {
				console.error('[ikenga.theme] subscriber threw', err);
			}
		}
	}

	/** Read the shell's `<html>`; null if not same-origin-readable. */
	function readShell(): ThemeSnapshot | null {
		try {
			if (window.parent === window) return null;
			const root = window.parent.document.documentElement;
			const mode = root.getAttribute('data-mode');
			if (mode !== 'light' && mode !== 'dark') return null;
			return {
				mode,
				theme: root.getAttribute('data-theme') || 'A',
				density: root.getAttribute('data-density') || 'comfortable',
			};
		} catch {
			// Cross-origin (standalone embed) — caller falls back to OS.
			return null;
		}
	}

	const fromShell = readShell();
	if (fromShell) {
		apply(fromShell);
		// Live-switch: re-mirror whenever the shell's attributes change.
		try {
			const target = window.parent.document.documentElement;
			const obs = new MutationObserver(() => {
				const next = readShell();
				if (next) apply(next);
			});
			obs.observe(target, {
				attributes: true,
				attributeFilter: ['data-mode', 'data-theme', 'data-density'],
			});
		} catch {
			// best-effort; the static apply above already themed the document.
		}
	} else {
		// Standalone — follow the OS color scheme. Palette has no host source,
		// so default to 'A'.
		const mql = window.matchMedia('(prefers-color-scheme: dark)');
		const fromOs = (): ThemeSnapshot => ({
			mode: mql.matches ? 'dark' : 'light',
			theme: 'A',
			density: 'comfortable',
		});
		apply(fromOs());
		const onChange = () => apply(fromOs());
		if (typeof mql.addEventListener === 'function') {
			mql.addEventListener('change', onChange);
		} else if (typeof mql.addListener === 'function') {
			// Safari < 14.
			mql.addListener(onChange);
		}
	}

	return {
		get mode() {
			return current.mode;
		},
		get theme() {
			return current.theme;
		},
		get density() {
			return current.density;
		},
		subscribe: (fn) => {
			subs.push(fn);
			return () => {
				const i = subs.indexOf(fn);
				if (i >= 0) subs.splice(i, 1);
			};
		},
	};
}

// ── Mount ────────────────────────────────────────────────────────────────

export function mountArtifactBridge(): void {
	// Idempotent: if an inline polyfill or a previous injection already
	// populated the bridge, do nothing. The host descriptor may still be
	// missing in that case (an inline polyfill won't set it), so set it
	// defensively without clobbering an existing value.
	if (!window.__ikenga_host__) {
		window.__ikenga_host__ = { kind: 'ikenga', user: null };
	}
	if (window.__ikenga_bridge_polyfill__) return;

	// Mirror the host theme onto the artifact ASAP — before the manifest-parse
	// early-returns below, so even a manifest-less HTML preview tracks the
	// shell's dark/light + palette. The handle is re-exposed on `art.theme`.
	const themeHandle = setupTheme();

	// Parse manifest. If absent or malformed, leave the host descriptor in
	// place but skip installing the polyfill — any inline polyfill in the
	// page will take over, and an authoring error is more useful than a
	// confusing partial bridge.
	const parsed = parseTagJson<Manifest>('ikenga-manifest');
	if (!parsed || typeof parsed.id !== 'string') {
		return;
	}
	// Aliased post-narrow so TS keeps the non-null type inside closures.
	const manifest: Manifest = parsed;

	const mock = parseTagJson<Record<string, unknown>>('ikenga-mock-data') ?? {};
	const dataSources = manifest.dataSources ?? {};

	const cache: Record<string, unknown> = {};
	const sourceSubs: Record<string, Array<(v: unknown) => void>> = {};
	const usedFallback: Record<string, boolean> = {};
	const intervalHandles: Record<string, ReturnType<typeof setInterval>> = {};

	const stateSubs: Record<string, Array<(v: unknown) => void>> = {};
	const stateNs = `ikenga:${manifest.id}:`;

	function resolve(name: string): Promise<unknown> {
		const def = dataSources[name];
		if (!def) {
			usedFallback[name] = true;
			return Promise.resolve(mock[name] ?? null);
		}

		if (def.type === 'fetch') {
			const fs = def as FetchSource;
			return fetch(fs.url, {
				method: fs.method || 'GET',
				headers: fs.headers,
			})
				.then((res) => {
					if (!res.ok) throw new Error(`http ${res.status}`);
					return res.json();
				})
				.then((data) => {
					usedFallback[name] = false;
					return data;
				})
				.catch(() => {
					usedFallback[name] = true;
					return name in mock ? mock[name] : null;
				});
		}

		// supabase | sql | mcp | file → mock-only in v0.
		usedFallback[name] = true;
		return Promise.resolve(name in mock ? mock[name] : null);
	}

	function fireSourceSubs(name: string, value: unknown): void {
		const subs = sourceSubs[name];
		if (!subs) return;
		// Iterate a copy so unsubscribes during dispatch don't skip entries.
		for (const fn of subs.slice()) {
			try {
				fn(value);
			} catch (err) {
				console.error('[ikenga.source] subscriber threw', err);
			}
		}
	}

	function refreshSource(name: string): Promise<void> {
		return resolve(name).then((v) => {
			cache[name] = v;
			fireSourceSubs(name, v);
		});
	}

	function setupRefreshMode(name: string, def: DataSource): void {
		const mode = def.refresh?.mode ?? 'manual';
		if (mode === 'interval') {
			const ms = parseDuration(def.refresh?.every);
			if (ms !== null && ms > 0) {
				intervalHandles[name] = setInterval(() => {
					void refreshSource(name);
				}, ms);
			}
		}
		// 'manual' → nothing to wire. 'watch' → no-op in v0 (Phase 2 routes
		// to host fs_watch).
	}

	function makeSourceHandle(name: string): SourceHandle {
		return {
			get: () => cache[name],
			subscribe: (fn) => {
				if (!sourceSubs[name]) sourceSubs[name] = [];
				sourceSubs[name].push(fn);
				return () => {
					const arr = sourceSubs[name];
					if (!arr) return;
					sourceSubs[name] = arr.filter((f) => f !== fn);
				};
			},
			refresh: () => refreshSource(name),
		};
	}

	const stateHandle: StateHandle = {
		get: (key) => {
			try {
				const raw = localStorage.getItem(stateNs + key);
				return raw === null ? null : JSON.parse(raw);
			} catch {
				return null;
			}
		},
		set: (key, value) => {
			try {
				localStorage.setItem(stateNs + key, JSON.stringify(value));
			} catch (err) {
				console.warn('[ikenga.state] failed to persist', key, err);
			}
			const subs = stateSubs[key];
			if (!subs) return;
			for (const fn of subs.slice()) {
				try {
					fn(value);
				} catch (err) {
					console.error('[ikenga.state] subscriber threw', err);
				}
			}
		},
		subscribe: (key, fn) => {
			if (!stateSubs[key]) stateSubs[key] = [];
			stateSubs[key].push(fn);
			return () => {
				const arr = stateSubs[key];
				if (!arr) return;
				stateSubs[key] = arr.filter((f) => f !== fn);
			};
		},
	};

	const notesHandle: NotesHandle = {
		send: (text, opts) => {
			// v0: log a structured payload. Phase 2 routes via postMessage
			// back to the originating chat session.
			console.log('[ikenga.notes]', {
				artifactId: manifest.id,
				text,
				opts: opts ?? {},
			});
		},
	};

	function init(): Promise<Art> {
		const keys = Object.keys(dataSources);
		return Promise.all(
			keys.map((k) =>
				resolve(k).then((v) => {
					cache[k] = v;
				})
			)
		).then(() => {
			// Wire refresh modes after the initial fetch so interval timers
			// don't double-fire during init.
			for (const k of keys) {
				const def = dataSources[k];
				if (def) setupRefreshMode(k, def);
			}

			const host = window.__ikenga_host__ ?? { kind: 'ikenga', user: null };

			return {
				manifest,
				host: {
					kind: host.kind,
					user: host.user,
					usedFallback: (n: string) => !!usedFallback[n],
					anyFallback: () => Object.values(usedFallback).some(Boolean),
				},
				source: makeSourceHandle,
				state: stateHandle,
				notes: notesHandle,
				theme: themeHandle,
				pin: () => {
					// v0 stub — Phase 2 will postMessage a pin-request to the
					// shell viewer host, which adds the artifact to the
					// activity bar.
					console.log('[ikenga.pin] requested', { artifactId: manifest.id });
				},
			};
		});
	}

	window.__ikenga_bridge_polyfill__ = { init };
}
