import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { type ITheme, Terminal } from '@xterm/xterm';
import { useEffect, useRef, useState } from 'react';
import { createOscObserver, fireOscNotification } from '@/lib/terminal/osc-notify';
import { registerPathLinks } from './path-links';
import { Pty, type PtySpawnOpts } from './pty-bridge';
import { readCaptureWithOffset } from './pty-output-buffer';
import { useTerminalStore } from './session-store';

export interface TerminalSpec {
	cwd: string;
	cmd: string[];
	env?: Record<string, string>;
}

interface Props {
	/**
	 * Spawn-mode: provide a spec and the host will spawn its own PTY (lifecycle
	 * tied to the component). Used for one-off terminals.
	 */
	spec?: TerminalSpec | null;
	/**
	 * Attach-mode: provide an existing PTY (managed externally, e.g. by the
	 * session store) and the host will only render. The PTY survives unmount.
	 */
	pty?: Pty | null;
	onStatus?: (s: string) => void;
	onExit?: (code: number | null) => void;
	/** Called once a PTY has been created in spawn-mode. */
	onPtyId?: (id: string) => void;
	/**
	 * Force the canvas/DOM renderer instead of WebGL. Detached windows
	 * (plans/multi-window WP-08) set this: WebGL "loads" in a secondary
	 * WebKitGTK webview but renders no glyphs (only the cursor) without ever
	 * firing onContextLoss, so the auto-fallback never triggers. Canvas works.
	 */
	disableWebgl?: boolean;
	/**
	 * Stable identity for the underlying terminal SESSION (not the PTY —
	 * `pty.id` changes across a restart, `sessionId` doesn't). When set
	 * (together with `pty`), the host reuses a module-scope cached
	 * `Terminal` + container `<div>` across remounts instead of building a
	 * fresh xterm wired only to future bytes — see the module-scope cache
	 * below. Omit for spawn-mode / detached-window usage, where every mount
	 * legitimately owns its own terminal.
	 */
	sessionId?: string;
	/**
	 * Whether the pane hosting this terminal currently has focus. Only
	 * consulted on a cache-hit remount (re-parenting a previously-cached
	 * terminal) to decide whether to steal DOM focus; a fresh terminal
	 * always focuses on creation, matching prior behavior.
	 */
	focused?: boolean;
}

const DARK_THEME: ITheme = {
	background: '#0a0a0a',
	foreground: '#e6e6e6',
	cursor: '#e6e6e6',
	cursorAccent: '#000000',
	selectionBackground: '#3a3d41',
	black: '#000000',
	red: '#cd3131',
	green: '#0dbc79',
	yellow: '#e5e510',
	blue: '#2472c8',
	magenta: '#bc3fbc',
	cyan: '#11a8cd',
	white: '#e5e5e5',
	brightBlack: '#666666',
	brightRed: '#f14c4c',
	brightGreen: '#23d18b',
	brightYellow: '#f5f543',
	brightBlue: '#3b8eea',
	brightMagenta: '#d670d6',
	brightCyan: '#29b8db',
	brightWhite: '#e5e5e5',
};

const LIGHT_THEME: ITheme = {
	background: '#ffffff',
	foreground: '#1f2328',
	cursor: '#1f2328',
	cursorAccent: '#ffffff',
	selectionBackground: '#cce0ff',
	black: '#24292f',
	red: '#cf222e',
	green: '#116329',
	yellow: '#4d2d00',
	blue: '#0969da',
	magenta: '#8250df',
	cyan: '#1b7c83',
	white: '#6e7781',
	brightBlack: '#57606a',
	brightRed: '#a40e26',
	brightGreen: '#1a7f37',
	brightYellow: '#633c01',
	brightBlue: '#218bff',
	brightMagenta: '#a475f9',
	brightCyan: '#3192aa',
	brightWhite: '#8c959f',
};

function isDarkMode(): boolean {
	if (typeof document === 'undefined') return true;
	return document.documentElement.classList.contains('dark');
}

function isMac(): boolean {
	if (typeof navigator === 'undefined') return false;
	// navigator.platform is deprecated but still works; fall back to userAgent.
	const p = navigator.platform || navigator.userAgent || '';
	return /Mac|iPhone|iPad/.test(p);
}

/**
 * Pick up theme overrides from CSS custom properties on :root if they exist.
 * Falls back to our hard-coded palette when a token is missing/empty.
 */
function readThemeFromCssVars(dark: boolean): ITheme {
	const base = dark ? DARK_THEME : LIGHT_THEME;
	if (typeof document === 'undefined') return base;
	const style = getComputedStyle(document.documentElement);
	const bg = style.getPropertyValue('--color-background').trim();
	const fg = style.getPropertyValue('--color-foreground').trim();
	return {
		...base,
		...(bg ? { background: bg } : {}),
		...(fg ? { foreground: fg, cursor: fg } : {}),
	};
}

// ---------------------------------------------------------------------------
// Module-scope xterm cache — mirrors `route-view.tsx`'s `routerCache` idiom.
//
// Keyed by terminal SESSION id (the terminal-store tab id, stable across a
// PTY restart), not by `pty.id`. Holds the live `Terminal` + its container
// `<div>` + every PTY-facing subscription so a pane-tree remount (tab
// switch/reorder/split/close — see plans/studio/17-deep-review §1) can
// re-parent the existing DOM node and resume writing instead of building a
// fresh `Terminal` wired only to future bytes (which made a live PTY look
// "restarted": scrollback + TUI screen state were discarded every remount).
//
// Per-mount concerns (key handler rebinding to this render's React state,
// theme/resize observers, the fit-retry loop) are NOT part of the cache —
// those are cheap to recreate and some (the key handler) MUST be rebound
// every mount since they close over this render's `setState`/refs.
// ---------------------------------------------------------------------------

interface SearchAddonLike {
	findNext: (s: string) => boolean;
	findPrevious: (s: string) => boolean;
	dispose: () => void;
}

interface XTermCacheEntry {
	term: Terminal;
	container: HTMLDivElement;
	fit: FitAddon;
	webglAddon: WebglAddon | null;
	webglUsed: boolean;
	searchAddon: SearchAddonLike | null;
	pathLinksDispose: () => void;
	oscObserver: ReturnType<typeof createOscObserver>;
	/** `pty.id` currently wired to `term`. Differs from a fresh `pty.id` after
	 *  a restart (same session, new process) — triggers a listener rewire. */
	wiredPtyId: string;
	detachData: () => void;
	detachExit: () => void;
	onDataDispose: { dispose: () => void };
	onResizeDispose: { dispose: () => void };
}

const xtermCache = new Map<string, XTermCacheEntry>();

function disposeCacheEntry(entry: XTermCacheEntry): void {
	try {
		entry.detachData();
	} catch {
		/* ignore */
	}
	try {
		entry.detachExit();
	} catch {
		/* ignore */
	}
	try {
		entry.onDataDispose.dispose();
	} catch {
		/* ignore */
	}
	try {
		entry.onResizeDispose.dispose();
	} catch {
		/* ignore */
	}
	try {
		entry.searchAddon?.dispose();
	} catch {
		/* ignore */
	}
	try {
		entry.pathLinksDispose();
	} catch {
		/* ignore */
	}
	try {
		entry.webglAddon?.dispose();
	} catch {
		/* ignore */
	}
	try {
		entry.term.dispose();
	} catch {
		/* xterm sometimes throws when renderer is mid-frame; safe to drop */
	}
}

function evictXtermCache(sessionId: string): void {
	const entry = xtermCache.get(sessionId);
	if (!entry) return;
	xtermCache.delete(sessionId);
	disposeCacheEntry(entry);
}

// Evict cache entries whose session the terminal store no longer tracks
// (tab removed — the session actually closed, not just a pane remount). One
// global subscription; terminal-tab churn is infrequent.
useTerminalStore.subscribe((state) => {
	const liveIds = new Set(state.tabs.map((t) => t.id));
	for (const id of Array.from(xtermCache.keys())) {
		if (!liveIds.has(id)) evictXtermCache(id);
	}
});

// HMR: a code change to this module would otherwise leave cached `Terminal`
// instances + their PTY listeners wired against closures from the previous
// module instance (stale `status`/`exit` refs, a `term.write` target the
// next module load can't reach). Dispose the whole cache right before the
// module is replaced so the next mount rebuilds clean — mirrors the
// `import.meta.hot.accept` guard in `route-view.tsx`, using `dispose` here
// since it's this module (not an imported one) that's being swapped.
if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		for (const entry of xtermCache.values()) disposeCacheEntry(entry);
		xtermCache.clear();
	});
}

/** Wire a `Terminal` to a `Pty`'s data/exit/resize streams. Used both when a
 *  cache entry is created and when an existing entry's underlying PTY
 *  identity changes (restart) and needs rewiring. */
function wirePtyToTerm(
	term: Terminal,
	pty: Pty,
	oscObserver: ReturnType<typeof createOscObserver>,
	status: (s: string) => void,
	exit: (code: number | null) => void,
	webglUsed: boolean
): {
	detachData: () => void;
	detachExit: () => void;
	onDataDispose: { dispose: () => void };
	onResizeDispose: { dispose: () => void };
} {
	const dataHandler = (bytes: Uint8Array) => {
		oscObserver.feed(bytes);
		term.write(bytes);
	};
	const exitHandler = (code: number | null) => {
		// VS Code pattern: keep the canvas mounted, write an inline notice as
		// the last line so anything the process *did* emit stays visible
		// above.
		try {
			const codeStr = code === null ? '?' : String(code);
			const hint =
				code !== null && code !== 0
					? '  (check command args or whether the --resume session id is still valid)'
					: '';
			term.writeln('');
			term.writeln(`\x1b[2m[process exited with code ${codeStr}]${hint}\x1b[0m`);
		} catch {
			/* terminal may be mid-dispose */
		}
		status(`pty exited (code=${code ?? '?'})`);
		exit(code);
	};
	const detachData = pty.onData(dataHandler);
	const detachExit = pty.onExit(exitHandler);
	const onDataDispose = term.onData((data) => {
		pty.write(data).catch(console.error);
	});
	const onResizeDispose = term.onResize(({ rows, cols }) => {
		pty.resize(rows, cols).catch(console.error);
	});
	// Sync initial size to PTY (in case we attached/rewired at a different
	// terminal geometry than the PTY currently has).
	try {
		pty.resize(term.rows, term.cols).catch(() => {});
	} catch {
		/* ignore */
	}
	status(`pty ${pty.id.slice(0, 8)} ${pty.label} (${webglUsed ? 'webgl' : 'canvas'})`);
	return { detachData, detachExit, onDataDispose, onResizeDispose };
}

export function XTermHost({
	spec,
	pty,
	onStatus,
	onExit,
	onPtyId,
	disableWebgl,
	sessionId,
	focused,
}: Props) {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const [searchOpen, setSearchOpen] = useState(false);
	const [searchTerm, setSearchTerm] = useState('');
	const searchInputRef = useRef<HTMLInputElement | null>(null);

	// Stash callbacks in refs so the spawn effect doesn't re-fire on each render.
	const onStatusRef = useRef(onStatus);
	const onExitRef = useRef(onExit);
	const onPtyIdRef = useRef(onPtyId);
	const focusedRef = useRef(focused);
	onStatusRef.current = onStatus;
	onExitRef.current = onExit;
	onPtyIdRef.current = onPtyId;
	focusedRef.current = focused;
	const status = (s: string) => onStatusRef.current?.(s);
	const exit = (code: number | null) => onExitRef.current?.(code);

	// Hold the search addon ref so the inline search input can drive it.
	const searchAddonRef = useRef<SearchAddonLike | null>(null);
	const termRef = useRef<Terminal | null>(null);

	useEffect(() => {
		// We must have either a spec (spawn) or a pty (attach) to render.
		if (!spec && !pty) return;
		if (!containerRef.current) return;

		const mountEl = containerRef.current;
		let cancelled = false;
		let disposed = false;
		const pendingRafs = new Set<number>();
		const pendingTimeouts = new Set<ReturnType<typeof setTimeout>>();

		// Only attach-mode mounts with a stable session id participate in the
		// module-scope cache. Spawn-mode (one-off terminals) and detached
		// windows (no `sessionId` passed) always get a fresh terminal, exactly
		// as before.
		const cacheable = Boolean(sessionId && pty);
		const cachedEntry = cacheable ? xtermCache.get(sessionId as string) : undefined;

		// Fit-retry loop shared by both the cache-hit and cache-miss paths —
		// re-declared per mount since it references this mount's `disposed`/
		// `pendingRafs` (created above) and the resolved `term`/`fit` below.
		let term: Terminal;
		let fit: FitAddon;
		let container: HTMLDivElement;

		const queueFit = (attempt = 0) => {
			const id = requestAnimationFrame(() => {
				pendingRafs.delete(id);
				if (disposed) return;
				if (!term.element || !term.element.isConnected) return;
				try {
					fit.fit();
				} catch {
					// Renderer not ready. Back off and retry: 16ms, 32ms, 64ms,
					// 128ms, 256ms — covers the WebGL init window on slow
					// machines without busy-looping. Give up after 5 tries;
					// ResizeObserver will still catch any later container-size
					// change.
					if (attempt >= 5) return;
					const delay = 16 << attempt;
					const t = setTimeout(() => {
						pendingTimeouts.delete(t);
						if (disposed) return;
						queueFit(attempt + 1);
					}, delay);
					pendingTimeouts.add(t);
				}
			});
			pendingRafs.add(id);
		};

		// Non-cached teardown state (spawn-mode ownedPty, and everything a
		// fresh non-cached mount creates that must be fully disposed on
		// unmount rather than handed to the cache).
		let ownedPty: Pty | null = null;
		let webglAddon: WebglAddon | null = null;
		let webglUsed = false;
		let disposeSearch: (() => void) | null = null;
		let pathLinksDisposeFn: (() => void) | null = null;
		let detachData: (() => void) | null = null;
		let detachExit: (() => void) | null = null;
		let onDataDispose: { dispose: () => void } | null = null;
		let onResizeDispose: { dispose: () => void } | null = null;
		let oscObserver: ReturnType<typeof createOscObserver>;

		if (cachedEntry) {
			// --- CACHE HIT: reuse the existing Terminal + container. ---
			term = cachedEntry.term;
			fit = cachedEntry.fit;
			container = cachedEntry.container;
			webglAddon = cachedEntry.webglAddon;
			webglUsed = cachedEntry.webglUsed;
			oscObserver = cachedEntry.oscObserver;

			termRef.current = term;
			searchAddonRef.current = cachedEntry.searchAddon;

			if (container.parentElement !== mountEl) {
				mountEl.appendChild(container);
			}

			// The underlying PTY changed identity since this entry was cached
			// (a restart minted a new process for the same session) — detach
			// the old listeners and rewire against the current one exactly
			// once, rather than leaving the terminal driving a dead PTY or
			// double-attaching to the new one.
			if (pty && cachedEntry.wiredPtyId !== pty.id) {
				cachedEntry.detachData();
				cachedEntry.detachExit();
				cachedEntry.onDataDispose.dispose();
				cachedEntry.onResizeDispose.dispose();
				const wired = wirePtyToTerm(term, pty, oscObserver, status, exit, webglUsed);
				cachedEntry.wiredPtyId = pty.id;
				cachedEntry.detachData = wired.detachData;
				cachedEntry.detachExit = wired.detachExit;
				cachedEntry.onDataDispose = wired.onDataDispose;
				cachedEntry.onResizeDispose = wired.onResizeDispose;
			}
		} else {
			// --- CACHE MISS (or non-cacheable spec/detached mode): build fresh. ---
			const dark = isDarkMode();
			term = new Terminal({
				fontFamily:
					'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
				fontSize: 13,
				lineHeight: 1.2,
				cursorBlink: true,
				cursorStyle: 'block',
				scrollback: 10_000,
				allowProposedApi: true,
				theme: readThemeFromCssVars(dark),
				macOptionIsMeta: true,
				convertEol: false,
			});
			termRef.current = term;

			fit = new FitAddon();
			const links = new WebLinksAddon();
			const unicode11 = new Unicode11Addon();
			term.loadAddon(fit);
			term.loadAddon(links);
			term.loadAddon(unicode11);
			term.unicode.activeVersion = '11';

			// File-path links (WebLinksAddon only handles URLs). Clicking a
			// path-shaped token opens it in the artifact viewer. Relative paths
			// resolve against the spawn cwd; absolute / ~ paths ignore it
			// (works in attach-mode too, where no cwd is known).
			const pathLinks = registerPathLinks(term, spec?.cwd);
			pathLinksDisposeFn = () => pathLinks.dispose();

			// Search addon — lazy import to keep initial bundle slim.
			(async () => {
				try {
					const mod = await import('@xterm/addon-search');
					if (cancelled) return;
					const search = new mod.SearchAddon();
					term.loadAddon(search);
					const searchLike: SearchAddonLike = {
						findNext: (s) => search.findNext(s),
						findPrevious: (s) => search.findPrevious(s),
						dispose: () => search.dispose(),
					};
					searchAddonRef.current = searchLike;
					disposeSearch = () => search.dispose();
					const entry = cacheable ? xtermCache.get(sessionId as string) : undefined;
					if (entry) entry.searchAddon = searchLike;
				} catch (err) {
					console.warn('[xterm] search addon failed to load', err);
				}
			})();

			// Cacheable (attach-mode + sessionId) mounts open into a nested div
			// so it can be re-parented on a later remount; non-cacheable mounts
			// (spec-mode, detached windows) open straight into the ref'd host
			// div, matching the pre-cache behavior exactly.
			if (cacheable) {
				container = document.createElement('div');
				container.style.width = '100%';
				container.style.height = '100%';
				mountEl.appendChild(container);
			} else {
				container = mountEl;
			}
			term.open(container);

			if (disableWebgl) {
				status('canvas renderer (webgl disabled)');
			} else {
				try {
					webglAddon = new WebglAddon();
					webglAddon.onContextLoss(() => {
						webglAddon?.dispose();
						webglAddon = null;
						status('webgl context lost — fell back to canvas');
						const entry = cacheable ? xtermCache.get(sessionId as string) : undefined;
						if (entry) entry.webglAddon = null;
					});
					term.loadAddon(webglAddon);
					webglUsed = true;
				} catch (err) {
					console.warn('[xterm] webgl addon failed, using canvas fallback', err);
					status('webgl unavailable — canvas renderer');
				}
			}

			oscObserver = createOscObserver({ onNotify: (n) => void fireOscNotification(n) });

			// Ring-replay fallback: attaching to a session whose PTY has been
			// alive without a cached xterm listening (cache was evicted, or
			// this is the first reclaim after a pop-out) — replay whatever the
			// per-session capture ring (pty-output-buffer.ts, wired once at
			// spawn in single-terminal.tsx) still holds before wiring the live
			// stream, so scrollback survives the gap. Mirrors the detached-
			// window `Pty.attach` scrollback replay (pty-bridge.ts), including
			// its offset reconciliation: the ring snapshot is tagged with an
			// absolute stream offset, and `primeExternalSnapshot` drops any
			// buffered/live bytes at or below that offset so the seam is not
			// double-painted. Must run before `wirePtyToTerm` attaches the live
			// `onData` subscriber (so a buffered replay is trimmed first).
			if (cacheable && sessionId && pty) {
				const snap = readCaptureWithOffset(sessionId);
				if (snap && snap.data.length > 0) {
					try {
						term.write(snap.data);
					} catch {
						/* ignore */
					}
					pty.primeExternalSnapshot(snap.endOffset);
				}
			}

			if (pty) {
				const wired = wirePtyToTerm(term, pty, oscObserver, status, exit, webglUsed);
				detachData = wired.detachData;
				detachExit = wired.detachExit;
				onDataDispose = wired.onDataDispose;
				onResizeDispose = wired.onResizeDispose;

				if (cacheable && sessionId) {
					xtermCache.set(sessionId, {
						term,
						container,
						fit,
						webglAddon,
						webglUsed,
						searchAddon: searchAddonRef.current,
						// Non-null: `pathLinksDisposeFn` is always assigned earlier
						// in this same (cache-miss) branch, before any code path
						// that can reach here.
						pathLinksDispose: pathLinksDisposeFn as () => void,
						oscObserver,
						wiredPtyId: pty.id,
						detachData,
						detachExit,
						onDataDispose,
						onResizeDispose,
					});
				}
			}
		}

		// --- Per-mount rebindings (always run, cache hit or miss). ---

		// Copy/paste + interrupt key handling. `attachCustomKeyEventHandler`
		// replaces any previously-registered handler wholesale, so re-running
		// this every mount is required (not a double-attach) — it rebinds the
		// closure to THIS mount's `setSearchOpen`/`searchInputRef`, which a
		// cache-hit reparent would otherwise leave pointed at a dead instance.
		term.attachCustomKeyEventHandler((e) => {
			if (e.type !== 'keydown') return true;
			const mac = isMac();
			const meta = mac ? e.metaKey : e.ctrlKey;
			const key = e.key.toLowerCase();

			// Mac: Cmd+C — copy if there's a selection, else fall through to PTY (SIGINT).
			if (mac && e.metaKey && !e.shiftKey && !e.altKey && key === 'c') {
				const sel = term.getSelection();
				if (sel) {
					navigator.clipboard.writeText(sel).catch(() => {});
					return false;
				}
				return true; // no selection: let the keystroke through (Cmd+C → ETX)
			}

			// Mac: Cmd+V — paste.
			if (mac && e.metaKey && !e.shiftKey && !e.altKey && key === 'v') {
				navigator.clipboard
					.readText()
					.then((t) => term.paste(t))
					.catch(() => {});
				return false;
			}

			// Linux/Windows: Ctrl+Shift+C — copy.
			if (!mac && e.ctrlKey && e.shiftKey && key === 'c') {
				const sel = term.getSelection();
				if (sel) {
					navigator.clipboard.writeText(sel).catch(() => {});
				}
				return false;
			}

			// Linux/Windows: Ctrl+Shift+V — paste.
			if (!mac && e.ctrlKey && e.shiftKey && key === 'v') {
				navigator.clipboard
					.readText()
					.then((t) => term.paste(t))
					.catch(() => {});
				return false;
			}

			// Cmd+F (mac) or Ctrl+Shift+F (linux) — open search.
			if (
				(mac && e.metaKey && key === 'f' && !e.shiftKey && !e.altKey) ||
				(!mac && e.ctrlKey && e.shiftKey && key === 'f')
			) {
				setSearchOpen(true);
				// Defer focus to next tick — input mounts after this returns.
				setTimeout(() => searchInputRef.current?.focus(), 0);
				return false;
			}

			// Plain Ctrl+C on linux still goes to PTY (xterm default — SIGINT).
			// No special handling needed; meta-only branch above is mac-only.
			void meta;
			return true;
		});

		// Theme sync — observe <html class="dark"> changes and CSS-var
		// updates. Recreated every mount (cheap, idempotent) rather than
		// cached, so it always reflects the live component tree.
		const themeObserver = new MutationObserver(() => {
			if (disposed) return;
			try {
				term.options.theme = readThemeFromCssVars(isDarkMode());
			} catch {
				/* ignore */
			}
		});
		themeObserver.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ['class', 'style', 'data-theme'],
		});

		// Defer fit() until after the renderer's first paint (see queueFit's
		// backoff comment above) — matters just as much on a cache-hit
		// re-parent, since the container just moved to a new DOM position.
		queueFit();

		let resizeObserver: ResizeObserver | null = new ResizeObserver(() => {
			if (disposed) return;
			queueFit();
		});
		resizeObserver.observe(container);

		if (cachedEntry) {
			// Re-parented an already-live terminal — only steal focus if the
			// hosting pane is actually the focused one.
			if (focusedRef.current) term.focus();
		} else if (pty) {
			// Fresh attach-mode mount — always focus, matching prior behavior.
			term.focus();
		}

		// Spawn-mode (non-cacheable) lifecycle: create a new PTY tied to this
		// component. Runs after the synchronous setup above so `queueFit` /
		// `resizeObserver` / focus logic is shared; spawn-mode never hits the
		// cache (`cacheable` is false whenever `spec` is used instead of `pty`).
		if (!pty && spec) {
			(async () => {
				try {
					const opts: PtySpawnOpts = {
						cwd: spec.cwd,
						cmd: spec.cmd,
						env: spec.env,
						rows: term.rows,
						cols: term.cols,
						label: spec.cmd.join(' '),
					};
					const p = await Pty.spawn(opts);
					if (cancelled) {
						await p.dispose().catch(() => {});
						return;
					}
					ownedPty = p;
					onPtyIdRef.current?.(p.id);
					const wired = wirePtyToTerm(term, p, oscObserver, status, exit, webglUsed);
					detachData = wired.detachData;
					detachExit = wired.detachExit;
					onDataDispose = wired.onDataDispose;
					onResizeDispose = wired.onResizeDispose;
					term.focus();
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					term.write(`\r\n[spawn failed] ${msg}\r\n`);
					status(`spawn failed: ${msg}`);
				}
			})();
		}

		return () => {
			cancelled = true;
			disposed = true;
			// Cancel any in-flight rAFs + retry timeouts so they can't run fit()
			// after dispose.
			for (const id of pendingRafs) cancelAnimationFrame(id);
			pendingRafs.clear();
			for (const t of pendingTimeouts) clearTimeout(t);
			pendingTimeouts.clear();
			themeObserver.disconnect();
			resizeObserver?.disconnect();
			resizeObserver = null;

			if (cacheable) {
				// Cached path: the terminal, its addons, and its PTY listeners
				// are owned by the module-scope cache now, not this mount.
				// Deliberately do NOT dispose them here — that's what made
				// every remount look like a restart. Eviction happens via the
				// terminal-store subscription (session actually closed) or the
				// HMR guard above, not on a plain unmount.
				return;
			}

			// Non-cached path (spec-mode / detached-window attach): tear
			// everything down exactly as before.
			onDataDispose?.dispose();
			onResizeDispose?.dispose();
			detachData?.();
			detachExit?.();
			disposeSearch?.();
			pathLinksDisposeFn?.();
			// Only kill the PTY if we own it (spawn-mode). In attach-mode the
			// session-store (or detached-window caller) owns the lifecycle.
			if (ownedPty) {
				ownedPty.dispose().catch(() => {});
			}
			// Null the ref BEFORE disposing so any late callback bails on the
			// null check rather than touching a half-torn-down renderer.
			termRef.current = null;
			try {
				webglAddon?.dispose();
			} catch {
				/* ignore */
			}
			try {
				term.dispose();
			} catch {
				/* xterm sometimes throws when renderer is mid-frame; safe to drop */
			}
		};
		// Re-fire when the underlying source changes. Callbacks live in refs;
		// `focused` is read via `focusedRef` so a pane-focus flip alone
		// doesn't tear down and re-run this whole mount effect.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [spec, pty, sessionId]);

	function runSearch(direction: 'next' | 'prev') {
		const addon = searchAddonRef.current;
		if (!addon || !searchTerm) return;
		if (direction === 'next') addon.findNext(searchTerm);
		else addon.findPrevious(searchTerm);
	}

	if (!spec && !pty) {
		return <div className="empty">No PTY. Spawn one above.</div>;
	}

	return (
		<div
			style={{
				position: 'relative',
				width: '100%',
				height: '100%',
				display: 'flex',
				flexDirection: 'column',
			}}
		>
			{searchOpen && (
				<div
					style={{
						display: 'flex',
						alignItems: 'center',
						gap: 4,
						padding: '4px 6px',
						borderBottom: '1px solid rgba(127,127,127,0.2)',
						background: 'rgba(127,127,127,0.06)',
						fontSize: 12,
					}}
				>
					<input
						ref={searchInputRef}
						value={searchTerm}
						onChange={(e) => setSearchTerm(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === 'Enter') {
								runSearch(e.shiftKey ? 'prev' : 'next');
							} else if (e.key === 'Escape') {
								setSearchOpen(false);
								termRef.current?.focus();
							}
						}}
						placeholder="Search…"
						style={{
							flex: 1,
							padding: '2px 6px',
							border: '1px solid rgba(127,127,127,0.3)',
							borderRadius: 3,
							background: 'transparent',
							color: 'inherit',
							fontSize: 12,
							outline: 'none',
						}}
					/>
					<button
						onClick={() => runSearch('prev')}
						style={{ fontSize: 11, padding: '1px 6px' }}
						title="Previous (Shift+Enter)"
					>
						↑
					</button>
					<button
						onClick={() => runSearch('next')}
						style={{ fontSize: 11, padding: '1px 6px' }}
						title="Next (Enter)"
					>
						↓
					</button>
					<button
						onClick={() => {
							setSearchOpen(false);
							termRef.current?.focus();
						}}
						style={{ fontSize: 11, padding: '1px 6px' }}
						title="Close (Esc)"
					>
						×
					</button>
				</div>
			)}
			<div ref={containerRef} className="terminal-host" style={{ flex: 1, minHeight: 0 }} />
		</div>
	);
}
