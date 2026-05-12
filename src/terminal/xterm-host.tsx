import { useEffect, useRef, useState } from 'react';
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import { Pty, type PtySpawnOpts } from './pty-bridge';

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

export function XTermHost({ spec, pty, onStatus, onExit, onPtyId }: Props) {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const [searchOpen, setSearchOpen] = useState(false);
	const [searchTerm, setSearchTerm] = useState('');
	const searchInputRef = useRef<HTMLInputElement | null>(null);

	// Stash callbacks in refs so the spawn effect doesn't re-fire on each render.
	const onStatusRef = useRef(onStatus);
	const onExitRef = useRef(onExit);
	const onPtyIdRef = useRef(onPtyId);
	onStatusRef.current = onStatus;
	onExitRef.current = onExit;
	onPtyIdRef.current = onPtyId;
	const status = (s: string) => onStatusRef.current?.(s);
	const exit = (code: number | null) => onExitRef.current?.(code);

	// Hold the search addon ref so the inline search input can drive it.
	const searchAddonRef = useRef<{
		findNext: (s: string) => boolean;
		findPrevious: (s: string) => boolean;
	} | null>(null);
	const termRef = useRef<Terminal | null>(null);

	useEffect(() => {
		// We must have either a spec (spawn) or a pty (attach) to render.
		if (!spec && !pty) return;
		if (!containerRef.current) return;

		const container = containerRef.current;
		let cancelled = false;

		const dark = isDarkMode();
		const term = new Terminal({
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

		const fit = new FitAddon();
		const links = new WebLinksAddon();
		const unicode11 = new Unicode11Addon();
		term.loadAddon(fit);
		term.loadAddon(links);
		term.loadAddon(unicode11);
		term.unicode.activeVersion = '11';

		// Search addon — lazy import to keep initial bundle slim.
		let disposeSearch: (() => void) | null = null;
		(async () => {
			try {
				const mod = await import('@xterm/addon-search');
				if (cancelled) return;
				const search = new mod.SearchAddon();
				term.loadAddon(search);
				searchAddonRef.current = search;
				disposeSearch = () => search.dispose();
			} catch (err) {
				console.warn('[xterm] search addon failed to load', err);
			}
		})();

		term.open(container);

		let webglUsed = false;
		let webglAddon: WebglAddon | null = null;
		try {
			webglAddon = new WebglAddon();
			webglAddon.onContextLoss(() => {
				webglAddon?.dispose();
				webglAddon = null;
				status('webgl context lost — fell back to canvas');
			});
			term.loadAddon(webglAddon);
			webglUsed = true;
		} catch (err) {
			console.warn('[xterm] webgl addon failed, using canvas fallback', err);
			status('webgl unavailable — canvas renderer');
		}

		// Defer fit() until after the renderer's first paint. xterm's renderer
		// value (canvas/webgl) isn't populated until a microtask after open();
		// calling fit() too early throws "undefined is not an object (evaluating
		// 'this._renderer.value.dimensions')".
		//
		// Track every queued rAF and a `disposed` flag so cleanup can short-
		// circuit in-flight callbacks. ResizeObserver fires async after the
		// observer is disconnected, and rAFs queued before disposal still
		// execute — both can hit a torn-down terminal otherwise.
		let disposed = false;
		const pendingRafs = new Set<number>();
		const pendingTimeouts = new Set<ReturnType<typeof setTimeout>>();
		// We retry fit() with backoff because the WebGL addon's renderer becomes
		// ready asynchronously *after* open() returns, and FitAddon.fit() throws
		// until the renderer value is populated. Before this loop the only retry
		// path was ResizeObserver, which doesn't fire unless the container size
		// changes — so a first-mount where fit() lost the race left xterm at its
		// default 80×24 cell grid forever (e.g. 875×432 px) and the canvas
		// therefore never painted any of the bytes that were already in the
		// terminal buffer. Manifested as a blank xterm despite a healthy PTY.
		const queueFit = (attempt = 0) => {
			const id = requestAnimationFrame(() => {
				pendingRafs.delete(id);
				if (disposed) return;
				if (!termRef.current) return;
				if (!term.element || !term.element.isConnected) return;
				try {
					fit.fit();
				} catch {
					// Renderer not ready. Back off and retry: 16ms, 32ms, 64ms,
					// 128ms, 256ms — covers the WebGL init window on slow machines
					// without busy-looping. Give up after 5 tries; ResizeObserver
					// will still catch any later container-size change.
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
		queueFit();

		// Theme sync — observe <html class="dark"> changes and CSS-var updates.
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

		// Copy/paste + interrupt key handling.
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

		// Variables for either spawn-mode or attach-mode lifecycle.
		let ownedPty: Pty | null = null;
		let detachData: (() => void) | null = null;
		let detachExit: (() => void) | null = null;
		let resizeObserver: ResizeObserver | null = null;
		let onDataDispose: { dispose: () => void } | null = null;
		let onResizeDispose: { dispose: () => void } | null = null;

		function attachToPty(p: Pty, label: string) {
			// PTY → terminal.
			const dataHandler = (bytes: Uint8Array) => term.write(bytes);
			const exitHandler = (code: number | null) => {
				// VS Code pattern: keep the canvas mounted, write an inline notice
				// as the last line so anything the process *did* emit stays visible
				// above. Without this the user sees a black box when claude exits
				// fast (e.g. stale --resume id) and has no idea why.
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
			// Wire onto the Pty instance — supports multiple subscribers via
			// pty-bridge's emitter pattern.
			const offData = p.onData(dataHandler);
			const offExit = p.onExit(exitHandler);
			detachData = offData;
			detachExit = offExit;

			// Terminal → PTY input.
			onDataDispose = term.onData((data) => {
				p.write(data).catch(console.error);
			});

			// Terminal → PTY resize.
			onResizeDispose = term.onResize(({ rows, cols }) => {
				p.resize(rows, cols).catch(console.error);
			});

			// Sync initial size to PTY (in case we attached after spawn with a
			// different terminal geometry).
			try {
				p.resize(term.rows, term.cols).catch(() => {});
			} catch {
				/* ignore */
			}

			status(`pty ${p.id.slice(0, 8)} ${label} (${webglUsed ? 'webgl' : 'canvas'})`);
		}

		(async () => {
			try {
				if (pty) {
					// Attach-mode: pty already running, just wire events.
					attachToPty(pty, pty.label);
				} else if (spec) {
					// Spawn-mode: create a new PTY tied to this component.
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
					attachToPty(p, spec.cmd.join(' '));
				}

				resizeObserver = new ResizeObserver(() => {
					// Defer to next frame so layout settles before measuring; queueFit
					// tracks the rAF id so dispose can cancel in-flight callbacks.
					if (disposed) return;
					queueFit();
				});
				resizeObserver.observe(container);

				term.focus();
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				term.write(`\r\n[spawn failed] ${msg}\r\n`);
				status(`spawn failed: ${msg}`);
			}
		})();

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
			onDataDispose?.dispose();
			onResizeDispose?.dispose();
			detachData?.();
			detachExit?.();
			disposeSearch?.();
			// Only kill the PTY if we own it (spawn-mode). In attach-mode the
			// session-store owns the lifecycle.
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
		// Re-fire when the underlying source changes. Callbacks live in refs.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [spec, pty]);

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
