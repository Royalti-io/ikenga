// Loupe density — single-artifact view.
//
// Layout: chrome / [renderer | right-rail] / version-strip.
//
// Right rail is tabbed (Chat / Code / DOM / Manifest), default Chat.
// The Code, DOM, and Manifest tabs are only meaningful for a single
// focused artifact, so they live on this density only (grid and compare
// surface Chat-only rails per the unified plan).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import {
	FolderTree,
	Pencil,
	Pin as PinGlyph,
	Save,
	Settings as SinkIcon,
	SquareDashedMousePointer,
	X,
} from 'lucide-react';
import { cn } from '@/components/ui/utils';
import {
	commentList,
	commentRoute,
	commentSetStatus,
	fsListenWatch,
	fsRead,
	fsUnwatch,
	fsWatch,
	fsWrite,
	iykeDomQuery,
	type Comment,
	type IykeDomResult,
} from '@/lib/tauri-cmd';
import { useTerminalStore } from '@/terminal/session-store';
import { RefreshCw, TreePine } from 'lucide-react';
import { usePaneStore } from '@/lib/panes/pane-store';
import { useChatStore } from '@/chat';
import { StudioSourceEditor } from '@/shell/artifact-studio/studio-source-editor';
import { StudioManifestEditor } from '@/shell/artifact-studio/studio-manifest-editor';
import { StudioEngineChat } from '@/shell/artifact-studio/studio-engine-chat';
import { StudioCommentMode } from '@/shell/artifact-studio/studio-comment-mode';
import { StudioPromoteDialog } from '@/shell/artifact-studio/studio-promote-dialog';
import { StudioTextEditMode } from '@/shell/artifact-studio/studio-text-edit-mode';
import {
	StudioSinkPopover,
	studioSinkToPreferredPtyId,
	studioSinkToRouteOverride,
	useArtifactSink,
	type StudioSink,
} from '@/shell/artifact-studio/studio-sink-popover';
import { pickRenderer } from '@/shell/artifact-studio/renderers';
import { RightRail, useRightRailTab } from '@/shell/artifact-studio/right-rail';
import { VersionStrip } from '@/shell/artifact-studio/version-strip';
import { extractManifestJson } from '@/lib/artifact/manifest-from-file';
import { writeManifestIntoHtml } from '@/lib/artifact/manifest-write';
import { getOrMintStudioThreadId } from '@/lib/artifact/studio-thread';
import { isArtifactWriteToolUse } from '@/lib/artifact/engine-writes';
import { ArtifactManifestSchema, type ArtifactManifest } from '@ikenga/contract/artifact';

interface StudioLoupeProps {
	path: string;
	paneId: string;
}

export function StudioLoupe({ path, paneId }: StudioLoupeProps) {
	const [source, setSource] = useState<string | null>(null);
	const [savedSource, setSavedSource] = useState<string | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [commentMode, setCommentMode] = useState(false);
	const [textEditMode, setTextEditMode] = useState(false);
	const [promoteOpen, setPromoteOpen] = useState(false);
	const [sinkOpen, setSinkOpen] = useState(false);
	const [pendingCommentChip, setPendingCommentChip] = useState<{ selector: string } | null>(null);
	const [rightTab, setRightTab] = useRightRailTab('chat');
	const { sink, setSink } = useArtifactSink(path);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const result = await fsRead(path);
				const html = new TextDecoder('utf-8', { fatal: false }).decode(
					new Uint8Array(result.bytes)
				);
				if (!cancelled) {
					setSource(html);
					setSavedSource(html);
				}
			} catch (e) {
				if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [path]);

	const dirty = source !== null && savedSource !== null && source !== savedSource;

	const manifest = useMemo<ArtifactManifest | null>(() => {
		if (source === null) return null;
		const json = extractManifestJson(source);
		if (!json) return null;
		try {
			const parsed = JSON.parse(json);
			const validated = ArtifactManifestSchema.safeParse(parsed);
			return validated.success ? validated.data : (parsed as ArtifactManifest);
		} catch {
			return null;
		}
	}, [source]);

	const save = useCallback(async () => {
		if (source === null || !dirty) return;
		try {
			await fsWrite(path, new TextEncoder().encode(source));
			setSavedSource(source);
		} catch (e) {
			setLoadError(e instanceof Error ? e.message : String(e));
		}
	}, [path, source, dirty]);

	const applyEngineEdit = useCallback(
		async (next: string) => {
			setSource(next);
			try {
				await fsWrite(path, new TextEncoder().encode(next));
				setSavedSource(next);
			} catch (e) {
				setLoadError(e instanceof Error ? e.message : String(e));
			}
		},
		[path]
	);

	useEngineWriteSync(path, (nextSource) => {
		setSource(nextSource);
		setSavedSource(nextSource);
	});

	const onKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLDivElement>) => {
			const isSave = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's';
			if (isSave) {
				e.preventDefault();
				void save();
			}
		},
		[save]
	);

	const updateManifest = useCallback(
		(next: ArtifactManifest, opts: { save?: boolean } = {}) => {
			if (source === null) return;
			const nextSource = writeManifestIntoHtml(source, next);
			setSource(nextSource);
			if (opts.save) {
				void fsWrite(path, new TextEncoder().encode(nextSource)).then(() =>
					setSavedSource(nextSource)
				);
			}
		},
		[path, source]
	);

	// Renderer kind hint deferred — today's ArtifactManifest schema is
	// HTML-flavoured (no `kind` field). When the schema grows a discriminator
	// (open question 1 in the unified plan), thread it in here.
	const Renderer = useMemo(() => pickRenderer(path).Component, [path]);

	if (loadError) {
		return (
			<div className="flex h-full w-full items-center justify-center p-6 text-sm text-destructive">
				Failed to open artifact: {loadError}
			</div>
		);
	}
	if (source === null) {
		return (
			<div className="flex h-full w-full items-center justify-center p-6 text-sm text-muted-foreground">
				Loading…
			</div>
		);
	}

	return (
		<div
			className="flex h-full w-full flex-col bg-background"
			onKeyDown={onKeyDown}
			data-pane-id={paneId}
			role="application"
			aria-label="Artifact Studio"
		>
			<StudioChrome
				path={path}
				dirty={dirty}
				manifest={manifest}
				commentMode={commentMode}
				textEditMode={textEditMode}
				sink={sink}
				onCommentModeToggle={() => {
					setCommentMode((v) => !v);
					// Comment + text-edit modes are mutually exclusive — they both
					// claim the iframe doc's click listener.
					setTextEditMode(false);
				}}
				onTextEditModeToggle={() => {
					setTextEditMode((v) => !v);
					setCommentMode(false);
				}}
				onSinkOpen={() => setSinkOpen(true)}
				onSave={save}
				onPromote={() => setPromoteOpen(true)}
				onClose={() =>
					usePaneStore.getState().replaceActiveViewAndPushHistory(paneId, {
						kind: 'artifact',
						path,
					})
				}
				onPinToggle={() => {
					if (!manifest) return;
					updateManifest(
						{
							...manifest,
							pin: {
								...(manifest.pin ?? { suggested: false }),
								suggested: !manifest.pin?.suggested,
							},
						},
						{ save: true }
					);
				}}
			/>
			<div className="flex-1 min-h-0 overflow-hidden">
				<PanelGroup direction="horizontal" autoSaveId={`studio-loupe:${path}`}>
					<Panel defaultSize={70} minSize={30}>
						<div className="relative h-full w-full">
							<Renderer path={path} paneId={paneId} density="loupe" source="pane" />
							<LoupePinOverlay path={path} paneId={paneId} sink={sink} />
							{commentMode && (
								<StudioCommentMode
									paneId={paneId}
									onSelect={(selector) => setPendingCommentChip({ selector })}
								/>
							)}
							{textEditMode && source !== null && (
								<StudioTextEditMode
									paneId={paneId}
									source={source}
									onCommit={(nextSource) => void applyEngineEdit(nextSource)}
								/>
							)}
						</div>
					</Panel>
					<PanelResizeHandle className="w-px bg-border hover:bg-accent" />
					<Panel defaultSize={30} minSize={20}>
						<RightRail
							tab={rightTab}
							onChangeTab={setRightTab}
							slots={{
								chat: (
									<StudioEngineChat
										path={path}
										pendingChip={pendingCommentChip}
										onConsumeChip={() => setPendingCommentChip(null)}
										onEngineEdit={applyEngineEdit}
									/>
								),
								code: <StudioSourceEditor value={source} onChange={setSource} />,
								dom: <DomInspector paneId={paneId} path={path} />,
								manifest: (
									<StudioManifestEditor
										manifest={manifest}
										onChange={(next) => updateManifest(next)}
									/>
								),
							}}
						/>
					</Panel>
				</PanelGroup>
			</div>
			<VersionStrip paneId={paneId} path={path} />
			<StudioPromoteDialog
				open={promoteOpen}
				onOpenChange={setPromoteOpen}
				path={path}
				source={source}
				manifest={manifest}
			/>
			<StudioSinkPopover
				open={sinkOpen}
				onOpenChange={setSinkOpen}
				anchorEl={
					sinkOpen
						? (document.querySelector<HTMLElement>(
								`[data-pane-id="${paneId}"] [data-studio-sink-anchor]`
							) ?? null)
						: null
				}
				sink={sink}
				onSinkChange={(next) => void setSink(next)}
			/>
		</div>
	);
}

// ─── Pin overlay ─────────────────────────────────────────────────────
//
// Renders open + in-progress pins over the renderer panel. Each pin's
// live rect is resolved by `iframe.contentDocument.querySelector(selector)`
// (same-origin: the viewer-server serves the artifact, the picker already
// uses this path). Re-projects on iframe content scroll, host resize, and
// post-edit DOM mutations.
//
// Pins whose selector no longer matches surface as a stale strip on the
// right edge — they remain reachable for review/resolve even when the
// element they pointed at has been refactored away. Resolved pins are
// hidden; loupe is the "focused work" surface.

interface ResolvedPin {
	pin: Comment;
	numbering: number;
	rect: { x: number; y: number } | null; // null = stale
}

function LoupePinOverlay({
	path,
	paneId,
	sink,
}: {
	path: string;
	paneId: string;
	sink: StudioSink;
}) {
	const qc = useQueryClient();
	const overlayRef = useRef<HTMLDivElement | null>(null);
	const [resolved, setResolved] = useState<ResolvedPin[]>([]);
	const [activePin, setActivePin] = useState<Comment | null>(null);

	const pinsQuery = useQuery({
		queryKey: ['artifact-studio', 'loupe', 'pins', path],
		queryFn: () => commentList({ artifactPath: path, includeResolved: false }),
		staleTime: 1_000,
	});
	const pins = useMemo(() => pinsQuery.data ?? [], [pinsQuery.data]);

	// Project each pin's selector through the same-origin iframe to a host-
	// viewport rect, then into overlay-local coords. Re-runs whenever the
	// iframe content scrolls / mutates / the host resizes.
	useEffect(() => {
		const overlay = overlayRef.current;
		if (!overlay) return;
		if (pins.length === 0) {
			setResolved([]);
			return;
		}

		let cancelled = false;
		let raf = 0;
		let iframe: HTMLIFrameElement | null = null;
		const teardowns: Array<() => void> = [];

		const project = () => {
			if (cancelled || !overlay) return;
			const overlayRect = overlay.getBoundingClientRect();
			const doc = iframe?.contentDocument;
			const iframeRect = iframe?.getBoundingClientRect();
			const next: ResolvedPin[] = pins.map((pin, i) => {
				if (!doc || !iframeRect) return { pin, numbering: i + 1, rect: null };
				let el: Element | null = null;
				try {
					el = doc.querySelector(pin.selector);
				} catch {
					el = null;
				}
				if (!el) return { pin, numbering: i + 1, rect: null };
				const er = el.getBoundingClientRect();
				const x = iframeRect.left + er.left + er.width / 2 - overlayRect.left;
				const y = iframeRect.top + er.top + er.height / 2 - overlayRect.top;
				return { pin, numbering: i + 1, rect: { x, y } };
			});
			setResolved(next);
		};

		const schedule = () => {
			if (raf) cancelAnimationFrame(raf);
			raf = requestAnimationFrame(project);
		};

		const attach = () => {
			iframe = document.querySelector<HTMLIFrameElement>(`[data-pane-id="${paneId}"] iframe`);
			if (!iframe) return false;
			const doc = iframe.contentDocument;
			if (!doc) return false;

			// Initial projection.
			project();

			// Recompute on iframe content scroll, host resize, and DOM
			// mutations (text-edit mode commits land here too).
			const onScroll = () => schedule();
			doc.addEventListener('scroll', onScroll, true);
			teardowns.push(() => doc.removeEventListener('scroll', onScroll, true));

			const ro = new ResizeObserver(schedule);
			ro.observe(overlay);
			if (doc.documentElement) ro.observe(doc.documentElement);
			teardowns.push(() => ro.disconnect());

			const mo = new MutationObserver(schedule);
			mo.observe(doc.documentElement ?? doc, {
				attributes: true,
				childList: true,
				subtree: true,
				characterData: true,
			});
			teardowns.push(() => mo.disconnect());

			return true;
		};

		// Iframe may not be in the DOM yet (HtmlFrame mounts after viewer
		// HTTP server is ready). Poll briefly until it shows up + has a
		// contentDocument, then attach the observers.
		let pollHandle: ReturnType<typeof setTimeout> | null = null;
		const poll = () => {
			if (cancelled) return;
			if (attach()) return;
			pollHandle = setTimeout(poll, 200);
		};
		poll();

		return () => {
			cancelled = true;
			if (pollHandle) clearTimeout(pollHandle);
			if (raf) cancelAnimationFrame(raf);
			for (const t of teardowns) t();
		};
	}, [pins, paneId]);

	const onRoutePin = useCallback(
		async (pin: Comment) => {
			const ts = useTerminalStore.getState();
			const activeTabPtyId = ts.tabs.find((t) => t.id === ts.activeId)?.ptyId ?? null;
			// Prefer the PTY id encoded in the sink (terminal:<id>) over the
			// focused-tab fallback. The override sink follows the same per-
			// artifact setting; `terminal:<id>` collapses to 'terminal'.
			const preferredPtyId = studioSinkToPreferredPtyId(sink) ?? activeTabPtyId;
			const overrideSink = studioSinkToRouteOverride(sink);
			try {
				await commentRoute({ id: pin.id, preferredPtyId, overrideSink });
				qc.invalidateQueries({ queryKey: ['artifact-studio', 'loupe', 'pins', path] });
			} catch (e) {
				console.error('[loupe] pin route failed', e);
			}
		},
		[qc, path, sink]
	);

	const onResolvePin = useCallback(
		async (pinId: number) => {
			try {
				await commentSetStatus(pinId, 'resolved');
				setActivePin(null);
				qc.invalidateQueries({ queryKey: ['artifact-studio', 'loupe', 'pins', path] });
			} catch (e) {
				console.error('[loupe] pin resolve failed', e);
			}
		},
		[qc, path]
	);

	const live = resolved.filter((r) => r.rect !== null);
	const stale = resolved.filter((r) => r.rect === null);

	return (
		<div ref={overlayRef} className="pointer-events-none absolute inset-0">
			{live.map((r) => (
				<LoupePinDot
					key={r.pin.id}
					pin={r.pin}
					numbering={r.numbering}
					x={r.rect!.x}
					y={r.rect!.y}
					onClick={() => setActivePin(r.pin)}
				/>
			))}
			{stale.length > 0 && <StalePinStrip pins={stale} onSelect={(pin) => setActivePin(pin)} />}
			{activePin && (
				<PinReviewPopover
					pin={activePin}
					anchorRect={resolved.find((r) => r.pin.id === activePin.id)?.rect ?? null}
					onClose={() => setActivePin(null)}
					onRoute={() => void onRoutePin(activePin)}
					onResolve={() => void onResolvePin(activePin.id)}
				/>
			)}
		</div>
	);
}

function LoupePinDot({
	pin,
	numbering,
	x,
	y,
	onClick,
}: {
	pin: Comment;
	numbering: number;
	x: number;
	y: number;
	onClick: () => void;
}) {
	const tone =
		pin.status === 'open'
			? 'bg-red-600 text-white'
			: pin.status === 'in_progress'
				? 'bg-amber-500 text-white'
				: 'bg-emerald-700 text-white';
	return (
		<button
			type="button"
			onClick={(e) => {
				e.stopPropagation();
				onClick();
			}}
			className={cn(
				'pointer-events-auto absolute flex h-5 w-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-background font-mono text-[10px] font-bold shadow transition-transform hover:scale-110',
				tone
			)}
			style={{ left: `${x}px`, top: `${y}px` }}
			title={`${pin.selector} — ${pin.text}`}
		>
			{numbering}
		</button>
	);
}

function StalePinStrip({
	pins,
	onSelect,
}: {
	pins: ResolvedPin[];
	onSelect: (pin: Comment) => void;
}) {
	return (
		<div className="pointer-events-auto absolute right-2 top-2 flex max-h-[60%] flex-col gap-1 overflow-y-auto rounded border border-border bg-background/95 p-1 shadow-md backdrop-blur-sm">
			<div className="px-1 font-mono text-[9px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
				Stale ({pins.length})
			</div>
			{pins.map((r) => (
				<button
					key={r.pin.id}
					type="button"
					onClick={() => onSelect(r.pin)}
					className="flex items-center gap-1.5 rounded px-1.5 py-1 text-left font-mono text-[10px] text-muted-foreground hover:bg-accent hover:text-accent-foreground"
					title={`${r.pin.selector} — ${r.pin.text}`}
				>
					<span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-muted text-[9px] font-bold">
						{r.numbering}
					</span>
					<span className="max-w-[140px] truncate">{r.pin.text}</span>
				</button>
			))}
		</div>
	);
}

function PinReviewPopover({
	pin,
	anchorRect,
	onClose,
	onRoute,
	onResolve,
}: {
	pin: Comment;
	anchorRect: { x: number; y: number } | null;
	onClose: () => void;
	onRoute: () => void;
	onResolve: () => void;
}) {
	const [screenshotUrl, setScreenshotUrl] = useState<string | null>(null);

	// Close on Escape / outside click.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') onClose();
		};
		const onDoc = (e: MouseEvent) => {
			const t = e.target as HTMLElement | null;
			if (t?.closest('[data-pin-review-popover]')) return;
			onClose();
		};
		window.addEventListener('keydown', onKey);
		window.addEventListener('mousedown', onDoc, true);
		return () => {
			window.removeEventListener('keydown', onKey);
			window.removeEventListener('mousedown', onDoc, true);
		};
	}, [onClose]);

	// Lazy-load the saved element screenshot from disk. Pin screenshots are
	// small (single cropped element), so fsRead → data URL is fine.
	useEffect(() => {
		if (!pin.screenshotPath) return;
		let cancelled = false;
		(async () => {
			try {
				const res = await fsRead(pin.screenshotPath!);
				if (cancelled) return;
				const bytes = new Uint8Array(res.bytes);
				let bin = '';
				for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
				const b64 = btoa(bin);
				setScreenshotUrl(`data:image/png;base64,${b64}`);
			} catch {
				if (!cancelled) setScreenshotUrl(null);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [pin.screenshotPath]);

	// Anchor the popover next to the dot when one exists; otherwise centre
	// it in the overlay (stale pins have no on-canvas anchor).
	const style: React.CSSProperties = anchorRect
		? { left: `${anchorRect.x + 14}px`, top: `${anchorRect.y + 14}px` }
		: { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' };

	return (
		<div
			data-pin-review-popover
			className="pointer-events-auto absolute z-30 w-72 rounded border border-border bg-background shadow-xl"
			style={style}
		>
			<div className="flex items-center justify-between border-b border-border px-2.5 py-1.5">
				<span className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
					Pin #{pin.id} · {pin.status}
				</span>
				<button
					type="button"
					onClick={onClose}
					aria-label="Close pin review"
					className="text-muted-foreground hover:text-foreground"
				>
					<X className="h-3 w-3" />
				</button>
			</div>
			{screenshotUrl && (
				<div className="flex justify-center border-b border-border bg-muted/30 p-2">
					<img
						src={screenshotUrl}
						alt="Pinned element"
						className="max-h-32 max-w-full object-contain"
					/>
				</div>
			)}
			<div className="space-y-2 px-2.5 py-2 text-xs">
				<div className="font-mono text-[10px] text-muted-foreground" title={pin.selector}>
					<span className="truncate">{pin.selector}</span>
				</div>
				<div className="italic text-foreground">"{pin.text}"</div>
			</div>
			<div className="flex gap-1 border-t border-border p-1.5">
				<button
					type="button"
					onClick={onRoute}
					className="flex-1 rounded border border-border bg-background px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.10em] hover:border-foreground/60 hover:bg-foreground/5"
				>
					Route
				</button>
				{pin.status !== 'resolved' && (
					<button
						type="button"
						onClick={onResolve}
						className="flex-1 rounded border border-emerald-700 bg-emerald-700/10 px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.10em] text-emerald-800 hover:bg-emerald-700/20"
					>
						Resolve
					</button>
				)}
			</div>
		</div>
	);
}

// ─── DOM inspector ────────────────────────────────────────────────────
//
// Per the unified plan's Open Question 7 (locked in Phase 2): the iyke
// viewer-server injects an iframe bridge into every served artifact;
// the bridge responds to `iyke://dom-request` by serializing the
// document's accessibility tree. The `iyke_dom_query` Tauri command
// (commands/iyke.rs) wraps that RPC for in-shell consumers — this
// component is the first one. Auto-refreshes on fs_watch of the
// artifact's parent dir so post-save renders pick up the new tree.

function DomInspector({ paneId, path }: { paneId: string; path: string }) {
	const [result, setResult] = useState<IykeDomResult | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [filter, setFilter] = useState('');

	const refresh = useCallback(
		async (q?: string) => {
			setLoading(true);
			setError(null);
			try {
				const out = await iykeDomQuery({
					pane: paneId,
					query: q && q.length > 0 ? q : undefined,
				});
				setResult(out);
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e));
			} finally {
				setLoading(false);
			}
		},
		[paneId]
	);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	// Auto-refresh on file save. Watch the artifact's parent dir (same
	// pattern HtmlFrame uses for iframe hot-reload) and debounce so a
	// burst of Create+Modify events only fires one DOM probe.
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
					// 250ms past the iframe-reload debounce (100ms) so the new
					// tree reflects the rendered output, not the pre-reload one.
					debounceTimer = setTimeout(() => {
						void refresh(filter);
					}, 250);
				});
			} catch {
				// Watcher best-effort; the manual refresh button still works.
			}
		})();

		return () => {
			cancelled = true;
			if (debounceTimer) clearTimeout(debounceTimer);
			if (unlisten) unlisten();
			if (watcherId) void fsUnwatch(watcherId);
		};
	}, [path, refresh, filter]);

	const onFilterChange = useCallback(
		(next: string) => {
			setFilter(next);
			void refresh(next);
		},
		[refresh]
	);

	return (
		<div className="flex h-full w-full flex-col">
			<div className="flex shrink-0 items-center gap-1.5 border-b border-border bg-muted/10 px-2 py-1.5">
				<TreePine className="h-3 w-3 text-muted-foreground" />
				<input
					type="text"
					value={filter}
					onChange={(e) => onFilterChange(e.target.value)}
					placeholder="filter (role / name / value)…"
					className="flex-1 rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[10px] placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-amber-500/50"
				/>
				<button
					type="button"
					onClick={() => refresh(filter)}
					disabled={loading}
					title="Refresh DOM tree"
					aria-label="Refresh DOM tree"
					className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-40"
				>
					<RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} />
				</button>
				{result && (
					<span className="font-mono text-[9px] uppercase tracking-[0.10em] text-muted-foreground">
						gen {result.generation}
					</span>
				)}
			</div>
			<div className="flex-1 min-h-0 overflow-auto p-2 font-mono text-[11px] leading-snug">
				{error ? (
					<div className="text-destructive">DOM probe failed: {error}</div>
				) : !result ? (
					<div className="text-muted-foreground">{loading ? 'Probing…' : 'No data yet.'}</div>
				) : result.text.length === 0 ? (
					<div className="text-muted-foreground">
						Empty tree.{' '}
						{filter ? 'No matches for the current filter.' : 'Iframe may still be loading.'}
					</div>
				) : (
					<pre className="whitespace-pre text-foreground/90">{result.text}</pre>
				)}
			</div>
		</div>
	);
}

// ─── Chrome ──────────────────────────────────────────────────────────

interface StudioChromeProps {
	path: string;
	dirty: boolean;
	manifest: ArtifactManifest | null;
	commentMode: boolean;
	textEditMode: boolean;
	sink: StudioSink;
	onCommentModeToggle: () => void;
	onTextEditModeToggle: () => void;
	onSinkOpen: () => void;
	onSave: () => void;
	onPromote: () => void;
	onPinToggle: () => void;
	onClose: () => void;
}

function StudioChrome({
	path,
	dirty,
	manifest,
	commentMode,
	textEditMode,
	sink,
	onCommentModeToggle,
	onTextEditModeToggle,
	onSinkOpen,
	onSave,
	onPromote,
	onPinToggle,
	onClose,
}: StudioChromeProps) {
	const name = manifest?.name ?? path.split('/').filter(Boolean).pop() ?? 'Artifact';
	const pinSuggested = manifest?.pin?.suggested === true;

	return (
		<div className="flex shrink-0 items-center gap-1.5 border-b border-border bg-muted/20 px-2 py-1 text-xs">
			<span className="font-medium text-foreground">{name}</span>
			{dirty && (
				<span
					className="h-1.5 w-1.5 rounded-full bg-amber-500"
					title="Unsaved changes — press ⌘S"
					role="status"
					aria-label="Unsaved changes"
				/>
			)}
			<span className="ml-auto flex items-center gap-0.5">
				<ChromeButton
					onClick={onCommentModeToggle}
					active={commentMode}
					title="Comment mode — click an element to annotate"
					aria-label="Toggle comment mode"
				>
					<SquareDashedMousePointer className="h-3.5 w-3.5" />
				</ChromeButton>
				<ChromeButton
					onClick={onTextEditModeToggle}
					active={textEditMode}
					title="Text-edit mode — click an element to edit its text"
					aria-label="Toggle text-edit mode"
				>
					<Pencil className="h-3.5 w-3.5" />
				</ChromeButton>
				<ChromeButton
					onClick={onPinToggle}
					active={pinSuggested}
					disabled={!manifest}
					title={pinSuggested ? 'Pin suggested (on)' : 'Pin suggested (off)'}
					aria-label="Toggle pin suggested"
				>
					<PinGlyph className={cn('h-3.5 w-3.5', pinSuggested && 'fill-current text-amber-500')} />
				</ChromeButton>
				<ChromeButton onClick={onPromote} title="Promote to folder…" aria-label="Promote to folder">
					<FolderTree className="h-3.5 w-3.5" />
				</ChromeButton>
				<ChromeButton
					onClick={onSinkOpen}
					active={sink !== 'inherit'}
					title={`Pin routing: ${sink}`}
					aria-label="Pin routing destination"
					data-studio-sink-anchor
				>
					<SinkIcon className="h-3.5 w-3.5" />
				</ChromeButton>
				<ChromeButton
					onClick={onSave}
					disabled={!dirty}
					title={dirty ? 'Save (⌘S)' : 'Saved'}
					aria-label="Save artifact"
				>
					<Save className="h-3.5 w-3.5" />
				</ChromeButton>
				<ChromeButton
					onClick={onClose}
					title="Close Studio (back to preview)"
					aria-label="Close Studio"
				>
					<X className="h-3.5 w-3.5" />
				</ChromeButton>
			</span>
		</div>
	);
}

type ChromeButtonProps = {
	onClick: () => void;
	active?: boolean;
	disabled?: boolean;
	title?: string;
	'aria-label': string;
	children: React.ReactNode;
} & {
	// Allow arbitrary data-* attributes so callers (e.g., the sink-popover
	// anchor) can mark the underlying <button> for later DOM lookup. Typed
	// loosely because TypeScript can't express "any key prefixed with
	// data-" cleanly.
	[k: `data-${string}`]: string | boolean | undefined;
};

function ChromeButton({ onClick, active, disabled, title, children, ...rest }: ChromeButtonProps) {
	// Forward any data-* attributes onto the <button> so they end up in the
	// DOM. Excludes aria-label which we render explicitly below.
	const dataAttrs: Record<string, string | boolean> = {};
	for (const [k, v] of Object.entries(rest)) {
		if (k.startsWith('data-') && v !== undefined) dataAttrs[k] = v;
	}
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			title={title}
			aria-label={rest['aria-label']}
			aria-pressed={active}
			{...dataAttrs}
			className={cn(
				'flex h-6 w-6 items-center justify-center rounded transition-colors',
				active
					? 'bg-accent text-accent-foreground'
					: 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
				'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent'
			)}
		>
			{children}
		</button>
	);
}

// ─── Engine-write sync (lifted from studio-pane.tsx) ─────────────────

function useEngineWriteSync(path: string, onWrite: (nextSource: string) => void) {
	const onWriteRef = useRef(onWrite);
	onWriteRef.current = onWrite;

	useEffect(() => {
		const threadId = getOrMintStudioThreadId(path);
		const processedIds = new Set<string>();

		const unsubscribe = useChatStore.subscribe((state) => {
			const events = state.threads[threadId]?.events;
			if (!events || events.length === 0) return;

			const useById = new Map<string, ReturnType<typeof toToolUse>>();
			for (const e of events) {
				const u = toToolUse(e);
				if (u) useById.set(u.id, u);
			}

			for (const e of events) {
				if (e.kind !== 'tool_result') continue;
				if (processedIds.has(e.id)) continue;
				if (e.isError) {
					processedIds.add(e.id);
					continue;
				}
				const use = useById.get(e.id);
				if (!use || !isArtifactWriteToolUse(use, path)) {
					processedIds.add(e.id);
					continue;
				}
				processedIds.add(e.id);
				void fsRead(path)
					.then((res) => {
						const text = new TextDecoder('utf-8', { fatal: false }).decode(
							new Uint8Array(res.bytes)
						);
						onWriteRef.current(text);
					})
					.catch(() => {
						// Best-effort — iframe fs_watch still reloads.
					});
			}
		});

		return () => {
			unsubscribe();
		};
	}, [path]);
}

function toToolUse(
	e: unknown
): { kind: 'tool_use'; id: string; name: string; input: unknown } | null {
	if (!e || typeof e !== 'object') return null;
	const ev = e as { kind?: unknown; id?: unknown; name?: unknown; input?: unknown };
	if (ev.kind !== 'tool_use' || typeof ev.id !== 'string' || typeof ev.name !== 'string') {
		return null;
	}
	return { kind: 'tool_use', id: ev.id, name: ev.name, input: ev.input };
}
