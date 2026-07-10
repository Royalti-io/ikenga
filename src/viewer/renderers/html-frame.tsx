import { useEffect, useRef, useState } from 'react';
import { AlertCircle, ExternalLink, Loader2, Pencil } from 'lucide-react';
import {
	fsListenWatch,
	fsRead,
	fsUnwatch,
	fsWatch,
	viewerServe,
	viewerStop,
	type ViewerHandle,
} from '@/lib/tauri-cmd';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { registerIykeIframe } from '@/lib/iyke/iframe-registry';
import { usePaneStore } from '@/lib/panes/pane-store';
import { cn } from '@/components/ui/utils';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { pickViewerRoot } from '../lib/relative-root';
import {
	attachElementPicker,
	PinComposer,
	type PickResult,
} from '@/shell/artifact-studio/pin-composer';

function isHtmlPath(path: string): boolean {
	const lower = path.toLowerCase();
	return lower.endsWith('.html') || lower.endsWith('.htm');
}

interface HtmlFrameProps {
	path: string;
	/** Pane ID for iyke iframe registration. Without it, the iyke CLI can't
	 * target the previewed page (DOM, screenshot, console). The artifact pane
	 * threads this through; standalone usages can omit it. */
	paneId?: string;
}

// Renders HTML artifacts in a sandboxed iframe served by the shared Rust
// viewer server (`viewer_serve` registers a token→root mount). The iframe
// loads from a `/__viewer/<token>/<file>` path on the shell's own origin —
// Vite proxies it in dev, tauri-plugin-localhost serves it in prod — so the
// iframe is **same-origin** with the shell. That's what lets
// modern-screenshot reach into the iframe DOM and lets the iyke iframe
// bridge run without postMessage cross-origin gymnastics.
//
// Sandbox flags:
// - `allow-scripts`: required for legitimate Claude-generated HTML that uses
//   inline scripts for interactivity.
// - `allow-same-origin`: required for relative `<link>` and `<script src>`
//   resolution and (now) for parent→iframe DOM access.
// External script loads are blocked by the CSP header injected on every
// response from the viewer server.
export function HtmlFrame({ path, paneId }: HtmlFrameProps) {
	const [state, setState] = useState<
		| { kind: 'loading' }
		| { kind: 'ready'; src: string; handle: ViewerHandle }
		| { kind: 'error'; message: string }
	>({ kind: 'loading' });
	const iframeRef = useRef<HTMLIFrameElement | null>(null);

	useEffect(() => {
		let cancelled = false;
		let handle: ViewerHandle | null = null;

		setState({ kind: 'loading' });

		fsRead(path)
			.then((res) => {
				const html = new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(res.bytes));
				const { root, file } = pickViewerRoot(path, html);
				return viewerServe(root).then((h) => ({ h, file }));
			})
			.then(({ h, file }) => {
				handle = h;
				if (cancelled) {
					// The mount was unmounted before the server finished spinning up —
					// tear it down to avoid leaking ports.
					void viewerStop(h.token);
					return;
				}
				// `h.url` is now a relative path (`/__viewer/<token>/`). Resolving
				// against `window.location.origin` keeps the iframe same-origin
				// with the shell while giving us a proper absolute URL to display
				// in the chrome strip.
				const src = `${window.location.origin}${h.url}${file}`;
				setState({ kind: 'ready', src, handle: h });
			})
			.catch((err) => {
				if (cancelled) return;
				setState({
					kind: 'error',
					message: err instanceof Error ? err.message : String(err),
				});
			});

		return () => {
			cancelled = true;
			if (handle) {
				void viewerStop(handle.token);
			}
		};
	}, [path]);

	// Hot-reload the iframe in place when the underlying file changes on disk.
	// Watches the parent directory (the viewer-server's root) so edits to
	// sibling assets (CSS/JS the page imports) also trigger a refresh, which
	// matches the user's mental model: "I edited the file, refresh the pane."
	// Debounced so a save that emits Create+Modify doesn't reload twice.
	useEffect(() => {
		let cancelled = false;
		let watcherId: string | null = null;
		let unlisten: (() => void) | null = null;
		let debounceTimer: ReturnType<typeof setTimeout> | null = null;

		void (async () => {
			try {
				const slash = path.lastIndexOf('/');
				const parent = slash > 0 ? path.slice(0, slash) : path;
				const id = await fsWatch(parent);
				if (cancelled) {
					void fsUnwatch(id);
					return;
				}
				watcherId = id;
				unlisten = await fsListenWatch(id, () => {
					if (cancelled) return;
					if (debounceTimer) clearTimeout(debounceTimer);
					debounceTimer = setTimeout(() => {
						const iframe = iframeRef.current;
						if (!iframe || !iframe.src) return;
						// Reassigning `src` re-fetches from the viewer-server, which has
						// no caching. The user sees only the iframe blink, not the app.
						iframe.src = iframe.src;
					}, 100);
				});
			} catch {
				// Watcher is best-effort — if it fails (path gone, perms), the user
				// can still manually re-open the artifact.
			}
		})();

		return () => {
			cancelled = true;
			if (debounceTimer) clearTimeout(debounceTimer);
			if (unlisten) unlisten();
			if (watcherId) void fsUnwatch(watcherId);
		};
	}, [path]);

	// Register the iframe with iyke once the viewer-server is up and the
	// iframe element exists. The viewer-server injects the iframe-side bridge
	// into the served HTML, so iyke DOM/click/console/network calls flow
	// through `iyke://iframe-message` for `--pane=<paneId>`.
	const readySrc = state.kind === 'ready' ? state.src : null;
	useEffect(() => {
		if (!paneId || !readySrc) return;
		const el = iframeRef.current;
		if (!el) return;
		return registerIykeIframe(paneId, el, 'html-frame');
	}, [paneId, readySrc]);

	// Pin composer state. Right-clicking an element inside the iframe pops
	// the composer; the picker stays attached for the lifetime of the
	// iframe element. Skipped when there's no `paneId` because grid
	// thumbnails (which have `pointer-events-none` and pass no paneId)
	// shouldn't be capturing contextmenu events.
	const [pick, setPick] = useState<PickResult | null>(null);
	// Right-clicking inside the artifact opens a host context menu anchored at
	// the cursor; "Add pin / comment here" is one item (it opens the composer
	// with the captured `pick`). Replaces the old behaviour of jumping straight
	// to the pin composer on every right-click.
	const [menu, setMenu] = useState<{ x: number; y: number; pick: PickResult } | null>(null);
	const replaceView = usePaneStore((s) => s.replaceActiveViewAndPushHistory);
	useEffect(() => {
		if (!paneId || !readySrc) return;
		const el = iframeRef.current;
		if (!el) return;
		// The iframe's contentDocument isn't available until the page-load
		// event fires. Wait for that before attaching so the picker doesn't
		// silently no-op on the loading-blank document.
		let detach: (() => void) | undefined;
		const wireUp = () => {
			detach?.();
			detach = attachElementPicker(el, (p, anchor) =>
				setMenu({ x: anchor.x, y: anchor.y, pick: p })
			);
		};
		// Attach immediately in case it's already loaded (re-mount races).
		wireUp();
		el.addEventListener('load', wireUp);
		return () => {
			el.removeEventListener('load', wireUp);
			detach?.();
		};
	}, [paneId, readySrc]);

	if (state.kind === 'loading') {
		return (
			<div className="flex h-full items-center justify-center text-xs text-muted-foreground">
				<Loader2 className="mr-2 h-4 w-4 animate-spin" /> Spinning up viewer…
			</div>
		);
	}
	if (state.kind === 'error') {
		return (
			<div className="flex h-full items-start justify-center p-6 text-xs text-destructive">
				<AlertCircle className="mr-2 mt-0.5 h-4 w-4 shrink-0" />
				<span className="break-all">{state.message}</span>
			</div>
		);
	}
	return (
		<div className="flex h-full flex-col">
			<div className="flex shrink-0 items-center gap-2 border-b border-border bg-muted/20 px-3 py-1.5 text-[11px] text-muted-foreground">
				<ExternalLink className="h-3 w-3" />
				<span className="truncate font-mono" title={state.src}>
					{state.src}
				</span>
				{paneId && isHtmlPath(path) && <OpenInStudioButton paneId={paneId} path={path} />}
			</div>
			<iframe
				ref={iframeRef}
				title={path}
				src={state.src}
				sandbox="allow-scripts allow-same-origin"
				className="h-full w-full flex-1 border-0 bg-background"
			/>
			<PinComposer
				open={pick !== null}
				pick={pick}
				artifactPath={path}
				onClose={() => setPick(null)}
			/>
			{/* Right-click on an iframe-internal element can't use a real DOM
			    contextmenu-on-trigger anchor (the event fires in the iframe's own
			    document), so this is a controlled DropdownMenu with a hidden,
			    cursor-positioned virtual trigger rather than Radix's ContextMenu. */}
			<DropdownMenu
				open={menu !== null}
				onOpenChange={(open) => {
					if (!open) setMenu(null);
				}}
			>
				<DropdownMenuTrigger asChild>
					<span
						aria-hidden
						className="pointer-events-none fixed h-0 w-0"
						style={{ left: menu?.x ?? 0, top: menu?.y ?? 0 }}
					/>
				</DropdownMenuTrigger>
				{menu && (
					<DropdownMenuContent align="start" sideOffset={0}>
						<DropdownMenuItem onSelect={() => setPick(menu.pick)}>
							Add pin / comment here…
						</DropdownMenuItem>
						<DropdownMenuItem onSelect={() => void writeText(path).catch(() => {})}>
							Copy path
						</DropdownMenuItem>
						{paneId && isHtmlPath(path) && (
							<DropdownMenuItem
								onSelect={() =>
									replaceView(paneId, { kind: 'artifact-studio', path, density: 'loupe' })
								}
							>
								Open in Studio
							</DropdownMenuItem>
						)}
						<DropdownMenuItem
							onSelect={() => {
								try {
									iframeRef.current?.contentWindow?.location.reload();
								} catch {
									/* cross-origin or detached — ignore */
								}
							}}
						>
							Reload
						</DropdownMenuItem>
					</DropdownMenuContent>
				)}
			</DropdownMenu>
		</div>
	);
}

interface OpenInStudioButtonProps {
	paneId: string;
	path: string;
}

function OpenInStudioButton({ paneId, path }: OpenInStudioButtonProps) {
	const replaceView = usePaneStore((s) => s.replaceActiveViewAndPushHistory);
	return (
		<button
			type="button"
			onClick={() => replaceView(paneId, { kind: 'artifact-studio', path, density: 'loupe' })}
			title="Open in Artifact Studio"
			aria-label="Open in Artifact Studio"
			className={cn(
				'ml-auto flex h-5 items-center gap-1 rounded px-2 text-[10.5px] font-semibold',
				'bg-primary text-primary-foreground shadow-sm transition-colors hover:bg-primary/90'
			)}
		>
			<Pencil className="h-3 w-3" />
			Open in Studio
		</button>
	);
}
