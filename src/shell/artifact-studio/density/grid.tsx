// Studio · grid density — Lightroom-style contact-sheet view over a
// folder of HTML artifacts. Variants stack under their parent (`./foo/`
// next to `./foo.html`). Pins overlay each thumbnail at the targeted
// element's normalized position; clicking a pin runs the routing
// dispatcher.
//
// Per the unified plan §"Right rail tabs", the grid-density rail is
// Chat-only. The Phase 1 `Chat | Pins` tab pair has been replaced with
// Chat + a slide-in pin overlay (active pin or "inbox" button opens it).

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Inbox, Settings, X } from 'lucide-react';
import { cn } from '@/components/ui/utils';
import { StudioFolderChat } from '@/shell/artifact-studio/studio-folder-chat';
import {
	commentList,
	commentRoute,
	commentSetStatus,
	fsList,
	ptyForegroundSnapshot,
	settingsGet,
	settingsSet,
	type Comment,
	type CommentStatus,
	type FileEntry,
	type RouteSink,
} from '@/lib/tauri-cmd';
import { ViewerRouter } from '@/viewer/auto-router';
import { usePaneStore } from '@/lib/panes/pane-store';
import {
	type ArtifactGridSettings,
	type DefaultSink,
	type StackMode,
	defaultSinkAsOverride,
	effectiveDefaultSink,
	effectiveStackMode,
	loadSettings,
	setFolderDefaultSink,
	setFolderStackMode,
} from '@/shell/artifact-studio/grid-settings';

function showResolvedKey(path: string): string {
	return `artifact-grid:show-resolved:${path}`;
}

const SETTINGS_QK = (path: string) => ['artifact-grid', 'settings', path] as const;

// When the visible-pin count (post Open/All filter) hits this threshold, the
// sidebar auto-flips from the active-pin view to inbox-mode: a flat list of
// every pin grouped by status. Below the threshold the active-pin sidebar
// remains, since most boards stay sparse.
const INBOX_THRESHOLD = 8;

interface InboxRow {
	pin: Comment;
	numbering: number; // 1-based, matches the dot label on the artifact thumbnail
}

function statusSortRank(s: CommentStatus): number {
	switch (s) {
		case 'open':
			return 0;
		case 'in_progress':
			return 1;
		case 'stale':
			return 2;
		case 'resolved':
			return 3;
	}
}

interface GridPaneProps {
	path: string;
	paneId: string;
}

/** Group artifacts by stack — `<name>.html` claims any siblings inside a
 *  child folder of the same basename as variants. The display order is the
 *  parent followed by its children (when expanded). */
interface StackedArtifact {
	parent: FileEntry;
	children: FileEntry[];
}

function groupStacks(entries: FileEntry[]): StackedArtifact[] {
	// Quick lookup for child folders by name.
	const dirsByName = new Map<string, FileEntry>();
	for (const e of entries) {
		if (e.isDir) dirsByName.set(e.name, e);
	}
	const stacks: StackedArtifact[] = [];
	for (const e of entries) {
		if (e.isDir) continue;
		if (!e.name.endsWith('.html')) continue;
		const base = e.name.slice(0, -'.html'.length);
		const dir = dirsByName.get(base);
		stacks.push({ parent: e, children: [] });
		if (dir) {
			// Look up the directory's contents lazily via a sibling query.
			// We pre-emptively store the dir entry on the parent name marker so
			// the FE can request its listing; the actual list is loaded by
			// `useStackChildren` only when the stack is expanded.
			(stacks[stacks.length - 1] as StackedArtifact & { childDirPath?: string }).childDirPath =
				dir.path;
		}
	}
	return stacks;
}

function fmtBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtAgo(ms: number): string {
	const delta = Date.now() - ms;
	const s = Math.floor(delta / 1000);
	if (s < 60) return `T-${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `T-${m}m`;
	const h = Math.floor(m / 60);
	if (h < 24) return `T-${h}h`;
	return `T-${Math.floor(h / 24)}d`;
}

export function StudioGrid({ path, paneId }: GridPaneProps) {
	const qc = useQueryClient();
	const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
	const [activePin, setActivePin] = useState<{
		artifactPath: string;
		pin: Comment;
	} | null>(null);
	// ⌥-click on a pin dot opens an override popover anchored to the dot's
	// screen position. Plain-click still routes immediately via the
	// auto-detected sink — the popover is the explicit-override path.
	const [overridePopover, setOverridePopover] = useState<{
		anchor: { x: number; y: number };
		artifact: FileEntry;
		pin: Comment;
	} | null>(null);
	const [settingsOpen, setSettingsOpen] = useState(false);

	// Grid-density right rail is Chat-only per the unified plan. Pin
	// detail / inbox surface as a slide-in overlay over the rail; opens
	// automatically when the user clicks a pin and can be summoned via
	// the inbox button.
	const [pinsOverlayOpen, setPinsOverlayOpen] = useState(false);

	const settingsQuery = useQuery({
		queryKey: SETTINGS_QK(path),
		queryFn: () => loadSettings(path),
		staleTime: 5_000,
	});
	const settings = settingsQuery.data;
	const effectiveSink: DefaultSink = settings ? effectiveDefaultSink(settings) : 'auto';
	const effectiveStack: StackMode = settings ? effectiveStackMode(settings) : 'collapsed';
	// Default true — fresh artifacts (no persisted choice) show All.
	const [showResolved, setShowResolved] = useState<boolean>(true);

	useEffect(() => {
		let cancelled = false;
		settingsGet(showResolvedKey(path))
			.then((raw) => {
				if (cancelled) return;
				if (raw === '0') setShowResolved(false);
				else if (raw === '1') setShowResolved(true);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [path]);

	const toggleShowResolved = useCallback(
		(next: boolean) => {
			setShowResolved(next);
			settingsSet(showResolvedKey(path), next ? '1' : '0').catch((e) => {
				console.error('[artifact-grid] persist show-resolved failed', e);
			});
		},
		[path]
	);

	// Auto-open the pins overlay when the user clicks a pin so routing
	// detail is immediately visible. Closing the overlay drops back to
	// Chat without clearing the active pin selection.
	useEffect(() => {
		if (activePin) setPinsOverlayOpen(true);
	}, [activePin]);

	const listingQuery = useQuery({
		queryKey: ['artifact-grid', path, 'listing'],
		queryFn: () => fsList(path),
		// Cell renders depend on this — accept the small staleness window
		// (the fs_watch on the artifact contents handles per-file change).
		staleTime: 2_000,
	});

	// Always fetch all pins; we filter in memory so both segment counts
	// (Open · All) derive from a single source of truth.
	//
	// `comment_list` only supports an exact artifactPath match; the grid is
	// a *folder* view, so we fetch global and prefix-filter here. Anything
	// inside `path/` belongs to this grid (covers both top-level artifacts
	// and variant subfolders, since pins for variants live at their absolute
	// paths under the folder root).
	const pinsQuery = useQuery({
		queryKey: ['artifact-grid', path, 'pins', 'all'],
		queryFn: async () => {
			const all = await commentList({ includeResolved: true });
			const prefix = path.endsWith('/') ? path : path + '/';
			return all.filter((p) => p.artifactPath === path || p.artifactPath.startsWith(prefix));
		},
		staleTime: 1_000,
	});

	const foregroundQuery = useQuery({
		queryKey: ['pty-foreground-snapshot'],
		queryFn: () => ptyForegroundSnapshot(),
		refetchInterval: 5_000,
	});

	// `pin://routed` is handled at the workspace level by
	// usePinRoutedListener so any artifact pane that creates a pin
	// dispatches reliably — not just ones rendered inside the grid.

	const stacks = useMemo(() => groupStacks(listingQuery.data ?? []), [listingQuery.data]);

	// Seed `expanded` once per (path, effective stack-mode) — when the setting
	// flips to `expanded`, every stack with children expands by default; when
	// it flips to `collapsed`, all collapse. Runtime per-stack toggles still
	// win until the user re-opens the grid.
	const [stackSeedKey, setStackSeedKey] = useState<string>('');
	useEffect(() => {
		if (!settings) return;
		const seedKey = `${path}|${effectiveStack}`;
		if (seedKey === stackSeedKey) return;
		setStackSeedKey(seedKey);
		if (effectiveStack === 'expanded') {
			const allWithChildren = new Set<string>();
			for (const s of stacks) {
				const childDir = (s as StackedArtifact & { childDirPath?: string }).childDirPath;
				if (childDir) allWithChildren.add(s.parent.path);
			}
			setExpanded(allWithChildren);
		} else {
			setExpanded(new Set());
		}
	}, [settings, effectiveStack, path, stacks, stackSeedKey]);

	const pinsByArtifact = useMemo(() => {
		const map = new Map<string, Comment[]>();
		for (const pin of pinsQuery.data ?? []) {
			if (!showResolved && pin.status === 'resolved') continue;
			const list = map.get(pin.artifactPath) ?? [];
			list.push(pin);
			map.set(pin.artifactPath, list);
		}
		return map;
	}, [pinsQuery.data, showResolved]);

	const claudePty = useMemo(() => {
		const snap = foregroundQuery.data ?? {};
		for (const [ptyId, fg] of Object.entries(snap)) {
			if (fg.name.startsWith('claude')) return { ptyId, name: fg.name };
		}
		return null;
	}, [foregroundQuery.data]);

	const toggleStack = useCallback((parentPath: string) => {
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(parentPath)) next.delete(parentPath);
			else next.add(parentPath);
			return next;
		});
	}, []);

	const onPinClick = useCallback(
		async (artifact: FileEntry, pin: Comment, override?: RouteSink) => {
			setActivePin({ artifactPath: artifact.path, pin });
			// Plain click: if no explicit override and the effective default
			// sink is non-auto, pass it as the override so the dispatcher
			// honors the user's preference. `auto` falls through to the
			// Rust-side foreground-PTY detection (existing behavior).
			const sink = override ?? defaultSinkAsOverride(effectiveSink);
			try {
				await commentRoute({ id: pin.id, overrideSink: sink });
				// Re-fetch pins so the status flip (open → in_progress when the
				// agent acknowledges) lands quickly.
				qc.invalidateQueries({ queryKey: ['artifact-grid', path, 'pins'] });
			} catch (e) {
				console.error('[artifact-grid] route failed', e);
			}
		},
		[path, qc, effectiveSink]
	);

	const onResolvePin = useCallback(
		async (pinId: number) => {
			await commentSetStatus(pinId, 'resolved');
			qc.invalidateQueries({ queryKey: ['artifact-grid', path, 'pins'] });
		},
		[path, qc]
	);

	// Inbox-mode rows: every filtered pin grouped by status, with numbering
	// that matches the dot label on the artifact thumbnail. Inbox follows the
	// Open/All filter via pinsByArtifact (resolved are already stripped when
	// showResolved=false).
	const inboxRows = useMemo<InboxRow[]>(() => {
		const rows: InboxRow[] = [];
		for (const pins of pinsByArtifact.values()) {
			pins.forEach((pin, i) => {
				rows.push({ pin, numbering: i + 1 });
			});
		}
		rows.sort((a, b) => {
			const sa = statusSortRank(a.pin.status);
			const sb = statusSortRank(b.pin.status);
			if (sa !== sb) return sa - sb;
			return a.pin.id - b.pin.id;
		});
		return rows;
	}, [pinsByArtifact]);

	const onInboxRowClick = useCallback(
		async (pin: Comment) => {
			setActivePin({ artifactPath: pin.artifactPath, pin });
			const sink = defaultSinkAsOverride(effectiveSink);
			try {
				await commentRoute({ id: pin.id, overrideSink: sink });
				qc.invalidateQueries({ queryKey: ['artifact-grid', path, 'pins'] });
			} catch (e) {
				console.error('[artifact-grid] route failed', e);
			}
		},
		[path, qc, effectiveSink]
	);

	const onPinAltClick = useCallback((artifact: FileEntry, pin: Comment, rect: DOMRect) => {
		// Anchor the popover just below the dot, centered horizontally.
		setOverridePopover({
			anchor: { x: rect.left + rect.width / 2, y: rect.bottom + 6 },
			artifact,
			pin,
		});
	}, []);

	const onOverridePick = useCallback(
		(sink: RouteSink) => {
			if (!overridePopover) return;
			const { artifact, pin } = overridePopover;
			setOverridePopover(null);
			onPinClick(artifact, pin, sink);
		},
		[overridePopover, onPinClick]
	);

	const onClosePopover = useCallback(() => setOverridePopover(null), []);

	const onOpenArtifact = useCallback((entry: FileEntry) => {
		const { focusedId, addTab } = usePaneStore.getState();
		addTab(focusedId, { kind: 'artifact', path: entry.path });
	}, []);

	if (listingQuery.isLoading) {
		return (
			<div className="flex h-full w-full items-center justify-center p-6 text-sm text-muted-foreground">
				Loading…
			</div>
		);
	}
	if (listingQuery.error) {
		return (
			<div className="flex h-full w-full items-center justify-center p-6 text-sm text-destructive">
				Failed to open folder: {String(listingQuery.error)}
			</div>
		);
	}

	const totalArtifacts = stacks.length;
	const allPins = pinsQuery.data ?? [];
	const totalOpenPins = allPins.filter((p) => p.status !== 'resolved').length;
	const totalAllPins = allPins.length;

	if (totalArtifacts === 0) {
		return (
			<div className="flex h-full w-full flex-col bg-background" data-pane-id={paneId}>
				<GridChrome
					path={path}
					counts={{ artifacts: 0, openPins: 0, allPins: 0 }}
					claudePty={claudePty}
					showResolved={showResolved}
					onToggleShowResolved={toggleShowResolved}
					onOpenSettings={() => setSettingsOpen(true)}
				/>
				<div className="flex flex-1 items-center justify-center p-8">
					<div className="max-w-md rounded border border-dashed border-border bg-muted/10 p-8 text-center">
						<div className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
							Empty board
						</div>
						<div className="mb-4 text-sm text-foreground">
							drop <code className="rounded bg-muted px-1 text-xs">.html</code> files into{' '}
							<code className="rounded bg-muted px-1 text-xs">{path}</code>, or run{' '}
							<code className="rounded bg-muted px-1 text-xs">iyke artifact new --in {path}</code>
						</div>
					</div>
				</div>
			</div>
		);
	}

	return (
		<div className="flex h-full w-full flex-col bg-background" data-pane-id={paneId}>
			<GridChrome
				path={path}
				counts={{ artifacts: totalArtifacts, openPins: totalOpenPins, allPins: totalAllPins }}
				claudePty={claudePty}
				showResolved={showResolved}
				onToggleShowResolved={toggleShowResolved}
				onOpenSettings={() => setSettingsOpen(true)}
			/>
			<div className="grid flex-1 min-h-0 grid-cols-[1fr_360px]">
				<div className="overflow-y-auto bg-background p-6">
					<div
						className="grid gap-4"
						style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}
					>
						{stacks.map((stack) => {
							const childDirPath = (stack as StackedArtifact & { childDirPath?: string })
								.childDirPath;
							const isExpanded = childDirPath ? expanded.has(stack.parent.path) : false;
							return (
								<GridCell
									key={stack.parent.path}
									entry={stack.parent}
									pins={pinsByArtifact.get(stack.parent.path) ?? []}
									variantCount={childDirPath ? '?' : 0}
									isExpanded={isExpanded}
									onToggleStack={childDirPath ? () => toggleStack(stack.parent.path) : undefined}
									onPinClick={(p) => onPinClick(stack.parent, p)}
									onPinAltClick={(p, rect) => onPinAltClick(stack.parent, p, rect)}
									onOpen={onOpenArtifact}
									childDirPath={isExpanded ? childDirPath : undefined}
									pinsByArtifact={pinsByArtifact}
									onPinClickGeneric={onPinClick}
									onPinAltClickGeneric={onPinAltClick}
									onOpenGeneric={onOpenArtifact}
								/>
							);
						})}
					</div>
				</div>
				<RightRail
					inboxCount={inboxRows.length}
					hasActivePin={!!activePin}
					overlayOpen={pinsOverlayOpen}
					onToggleOverlay={() => setPinsOverlayOpen((v) => !v)}
					chat={<StudioFolderChat folderPath={path} />}
					pinsOverlay={
						inboxRows.length >= INBOX_THRESHOLD ? (
							<GridSidebarInbox
								rows={inboxRows}
								activePinId={activePin?.pin.id ?? null}
								claudePty={claudePty}
								onSelectAndRoute={onInboxRowClick}
								onResolve={onResolvePin}
							/>
						) : (
							<GridSidebar activePin={activePin} claudePty={claudePty} onResolve={onResolvePin} />
						)
					}
					onCloseOverlay={() => setPinsOverlayOpen(false)}
				/>
			</div>
			{overridePopover &&
				createPortal(
					<OverridePopover
						anchor={overridePopover.anchor}
						onPick={onOverridePick}
						onClose={onClosePopover}
					/>,
					document.body
				)}
			{settingsOpen &&
				settings &&
				createPortal(
					<FolderSettingsModal
						path={path}
						settings={settings}
						onClose={() => setSettingsOpen(false)}
						onChanged={() => qc.invalidateQueries({ queryKey: SETTINGS_QK(path) })}
					/>,
					document.body
				)}
		</div>
	);
}

interface RightRailProps {
	hasActivePin: boolean;
	inboxCount: number;
	overlayOpen: boolean;
	onToggleOverlay: () => void;
	onCloseOverlay: () => void;
	chat: ReactNode;
	pinsOverlay: ReactNode;
}

/** Chat-only right rail with a slide-in pins overlay. The overlay opens
 *  automatically when the user clicks a pin (active-pin detail) and can
 *  be summoned via the inbox button when ≥ INBOX_THRESHOLD pins are
 *  visible. Code / DOM / Manifest tabs from the unified plan are
 *  intentionally absent at grid density (no single focused artifact).
 *
 *  See plans/shell/2026-05-16-artifact-studio-unified.md §"Right rail
 *  tabs". */
function RightRail({
	hasActivePin,
	inboxCount,
	overlayOpen,
	onToggleOverlay,
	onCloseOverlay,
	chat,
	pinsOverlay,
}: RightRailProps) {
	const showInboxButton = inboxCount > 0 || hasActivePin;
	const badge = hasActivePin ? '●' : inboxCount > 0 ? String(inboxCount) : null;
	return (
		<div className="relative flex h-full min-h-0 flex-col border-l border-border bg-background">
			<div className="flex shrink-0 items-center justify-between border-b border-border bg-muted/20 px-2 py-1.5">
				<span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
					Chat
				</span>
				{showInboxButton && (
					<button
						type="button"
						onClick={onToggleOverlay}
						aria-pressed={overlayOpen}
						title={overlayOpen ? 'Close pin inbox' : 'Open pin inbox'}
						className={cn(
							'flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] transition-colors',
							overlayOpen
								? 'bg-accent text-accent-foreground'
								: 'text-muted-foreground hover:bg-muted/40 hover:text-foreground'
						)}
					>
						<Inbox className="h-3 w-3" />
						{badge && (
							<span
								className={cn(
									'font-mono text-[9px]',
									hasActivePin ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground'
								)}
							>
								{badge}
							</span>
						)}
					</button>
				)}
			</div>
			<div className="flex-1 min-h-0 overflow-hidden">{chat}</div>
			{overlayOpen && (
				<div className="absolute inset-0 z-10 flex flex-col bg-background shadow-lg">
					<div className="flex shrink-0 items-center justify-between border-b border-border bg-muted/30 px-2 py-1.5">
						<span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
							Pins
						</span>
						<button
							type="button"
							onClick={onCloseOverlay}
							aria-label="Close pin inbox"
							className="rounded p-0.5 text-muted-foreground hover:bg-muted/40 hover:text-foreground"
						>
							<X className="h-3 w-3" />
						</button>
					</div>
					<div className="flex-1 min-h-0 overflow-hidden">{pinsOverlay}</div>
				</div>
			)}
		</div>
	);
}

interface GridChromeProps {
	path: string;
	counts: { artifacts: number; openPins: number; allPins: number };
	claudePty: { ptyId: string; name: string } | null;
	showResolved: boolean;
	onToggleShowResolved: (next: boolean) => void;
	onOpenSettings: () => void;
}

function GridChrome({
	path,
	counts,
	claudePty,
	showResolved,
	onToggleShowResolved,
	onOpenSettings,
}: GridChromeProps) {
	return (
		<div className="flex shrink-0 items-center gap-3 border-b border-border bg-muted/20 px-3 py-1.5 text-xs">
			<span className="font-mono font-semibold tracking-[0.18em] uppercase text-foreground">
				Ikenga · Grid
			</span>
			<span className="text-muted-foreground">·</span>
			<span className="font-mono text-foreground">{path}</span>
			<span className="ml-auto flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.10em] text-muted-foreground">
				<span>
					{counts.artifacts} artifact{counts.artifacts === 1 ? '' : 's'}
				</span>
				<FilterPill
					showResolved={showResolved}
					openCount={counts.openPins}
					allCount={counts.allPins}
					onChange={onToggleShowResolved}
				/>
				<span>
					{claudePty ? (
						<>
							<span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
							claude · {claudePty.ptyId.slice(0, 6)}
						</>
					) : (
						<>
							<span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />
							no claude · sidepane fallback
						</>
					)}
				</span>
				<button
					type="button"
					onClick={onOpenSettings}
					className="cursor-pointer rounded p-1 text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
					title="Folder settings (artifact grid)"
				>
					<Settings className="h-3.5 w-3.5" />
				</button>
			</span>
		</div>
	);
}

interface FilterPillProps {
	showResolved: boolean;
	openCount: number;
	allCount: number;
	onChange: (next: boolean) => void;
}

function FilterPill({ showResolved, openCount, allCount, onChange }: FilterPillProps) {
	const baseSeg =
		'cursor-pointer px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.10em] transition-colors';
	const openActive = !showResolved;
	const allActive = showResolved;
	const openAccent = openCount > 0;
	return (
		<span className="inline-flex overflow-hidden rounded border border-border">
			<button
				type="button"
				onClick={() => onChange(false)}
				className={
					baseSeg +
					(openActive
						? openAccent
							? ' border-r border-destructive bg-destructive/10 text-destructive'
							: ' border-r border-border bg-foreground/10 text-foreground'
						: ' border-r border-border text-muted-foreground hover:text-foreground')
				}
				title="Show only open + in-progress pins"
			>
				Open <span className="font-bold">{openCount}</span>
			</button>
			<button
				type="button"
				onClick={() => onChange(true)}
				className={
					baseSeg +
					(allActive
						? ' bg-foreground/10 text-foreground'
						: ' text-muted-foreground hover:text-foreground')
				}
				title="Show every pin, including resolved"
			>
				All <span className="font-bold">{allCount}</span>
			</button>
		</span>
	);
}

interface GridCellProps {
	entry: FileEntry;
	pins: Comment[];
	variantCount: number | '?';
	isExpanded: boolean;
	onToggleStack?: () => void;
	onPinClick: (pin: Comment) => void;
	onPinAltClick: (pin: Comment, rect: DOMRect) => void;
	onOpen: (entry: FileEntry) => void;
	childDirPath?: string;
	pinsByArtifact: Map<string, Comment[]>;
	onPinClickGeneric: (artifact: FileEntry, pin: Comment) => void;
	onPinAltClickGeneric: (artifact: FileEntry, pin: Comment, rect: DOMRect) => void;
	onOpenGeneric: (entry: FileEntry) => void;
	isVariant?: boolean;
}

function GridCell({
	entry,
	pins,
	variantCount,
	isExpanded,
	onToggleStack,
	onPinClick,
	onPinAltClick,
	onOpen,
	childDirPath,
	pinsByArtifact,
	onPinClickGeneric,
	onPinAltClickGeneric,
	onOpenGeneric,
	isVariant,
}: GridCellProps) {
	return (
		<>
			<div
				onClick={() => onOpen(entry)}
				className={
					'group relative flex cursor-pointer flex-col overflow-hidden rounded border border-border bg-background transition-colors hover:border-foreground/40 ' +
					(isVariant ? 'bg-muted/30' : '')
				}
				style={{ height: 240 }}
			>
				<div className="absolute -top-2 left-2 z-10 max-w-[calc(100%-16px)] truncate border border-border bg-background px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-[0.06em]">
					{entry.name}
				</div>
				<div className="flex items-baseline justify-between px-3 pt-4 pb-1 font-mono text-[9px] uppercase tracking-[0.10em] text-muted-foreground">
					<span>{fmtBytes(entry.size)}</span>
					<span>{fmtAgo(entry.modifiedMs)}</span>
				</div>
				<div className="relative mx-3 flex-1 overflow-hidden border border-border bg-muted/10">
					{/* Live iframe thumbnail. ViewerRouter is the same renderer the
					    full artifact view uses; we just scale it down inside a
					    sized container. IntersectionObserver-style lazy load is a
					    later patch — v0 mounts iframes eagerly per cell, which is
					    fine at the expected ~6–20 artifact scale. */}
					<div
						className="pointer-events-none origin-top-left"
						style={{
							width: 800,
							height: 600,
							transform: 'scale(0.27)',
						}}
					>
						<ViewerRouter path={entry.path} source="pane" />
					</div>
					<span className="absolute right-1 top-1 border border-border bg-background px-1 font-mono text-[8px] uppercase tracking-[0.20em] text-muted-foreground">
						iframe
					</span>
					{pins.map((p, i) => (
						<PinDot
							key={p.id}
							pin={p}
							numbering={i + 1}
							onClick={() => onPinClick(p)}
							onAltClick={(rect) => onPinAltClick(p, rect)}
						/>
					))}
				</div>
				<div className="flex items-baseline justify-between px-3 py-1.5 font-mono text-[9px] uppercase tracking-[0.10em] text-muted-foreground">
					<span>{pins.length > 0 ? `${pins.length} pin${pins.length === 1 ? '' : 's'}` : ''}</span>
					{onToggleStack && variantCount !== 0 && (
						<button
							type="button"
							onClick={(e) => {
								e.stopPropagation();
								onToggleStack();
							}}
							className="cursor-pointer text-emerald-600 hover:text-foreground"
						>
							{isExpanded ? '− collapse' : '+ var ▾'}
						</button>
					)}
				</div>
			</div>
			{isExpanded && childDirPath && (
				<GridStackChildren
					dirPath={childDirPath}
					pinsByArtifact={pinsByArtifact}
					onPinClick={onPinClickGeneric}
					onPinAltClick={onPinAltClickGeneric}
					onOpen={onOpenGeneric}
				/>
			)}
		</>
	);
}

interface GridStackChildrenProps {
	dirPath: string;
	pinsByArtifact: Map<string, Comment[]>;
	onPinClick: (artifact: FileEntry, pin: Comment) => void;
	onPinAltClick: (artifact: FileEntry, pin: Comment, rect: DOMRect) => void;
	onOpen: (entry: FileEntry) => void;
}

function GridStackChildren({
	dirPath,
	pinsByArtifact,
	onPinClick,
	onPinAltClick,
	onOpen,
}: GridStackChildrenProps) {
	const childrenQuery = useQuery({
		queryKey: ['artifact-grid', 'stack-children', dirPath],
		queryFn: () => fsList(dirPath),
		staleTime: 2_000,
	});
	const children = (childrenQuery.data ?? []).filter((e) => !e.isDir && e.name.endsWith('.html'));
	if (children.length === 0) return null;
	return (
		<div
			className="col-span-full ml-6 mt-[-8px] border-l-2 border-border pl-4 pb-2 grid gap-3"
			style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))' }}
		>
			{children.map((child) => (
				<GridCell
					key={child.path}
					entry={child}
					pins={pinsByArtifact.get(child.path) ?? []}
					variantCount={0}
					isExpanded={false}
					onPinClick={(p) => onPinClick(child, p)}
					onPinAltClick={(p, rect) => onPinAltClick(child, p, rect)}
					onOpen={onOpen}
					pinsByArtifact={pinsByArtifact}
					onPinClickGeneric={onPinClick}
					onPinAltClickGeneric={onPinAltClick}
					onOpenGeneric={onOpen}
					isVariant
				/>
			))}
		</div>
	);
}

interface PinDotProps {
	pin: Comment;
	numbering: number;
	onClick: () => void;
	onAltClick: (rect: DOMRect) => void;
}

function PinDot({ pin, numbering, onClick, onAltClick }: PinDotProps) {
	const tone =
		pin.status === 'open'
			? 'bg-red-600 text-white'
			: pin.status === 'in_progress'
				? 'bg-amber-500 text-white'
				: 'bg-emerald-700 text-white';
	const muted = pin.status === 'resolved' ? 'opacity-40' : '';
	const x = pin.positionX ?? 0.5;
	const y = pin.positionY ?? 0.5;
	return (
		<button
			type="button"
			onClick={(e) => {
				e.stopPropagation();
				if (e.altKey) {
					onAltClick(e.currentTarget.getBoundingClientRect());
				} else {
					onClick();
				}
			}}
			className={`absolute flex h-4 w-4 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-background font-mono text-[9px] font-bold shadow ${tone} ${muted}`}
			style={{ left: `${x * 100}%`, top: `${y * 100}%` }}
			title={`${pin.selector} — ${pin.text}\n(⌥-click to override sink)`}
		>
			{numbering}
		</button>
	);
}

interface OverridePopoverProps {
	anchor: { x: number; y: number };
	onPick: (sink: RouteSink) => void;
	onClose: () => void;
}

function OverridePopover({ anchor, onPick, onClose }: OverridePopoverProps) {
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') onClose();
		};
		const onDocClick = (e: MouseEvent) => {
			const target = e.target as HTMLElement | null;
			if (target && target.closest('[data-override-popover]')) return;
			onClose();
		};
		window.addEventListener('keydown', onKey);
		// Use capture so the popover closes before any underlying click
		// handler (e.g. a different pin) fires. The popover content sets a
		// data-attr that the handler short-circuits on.
		window.addEventListener('mousedown', onDocClick, true);
		return () => {
			window.removeEventListener('keydown', onKey);
			window.removeEventListener('mousedown', onDocClick, true);
		};
	}, [onClose]);

	return (
		<div
			data-override-popover
			className="fixed z-50 -translate-x-1/2 rounded border border-border bg-background shadow-lg"
			style={{ left: anchor.x, top: anchor.y, minWidth: 180 }}
		>
			<div className="flex gap-1 p-1.5">
				<button
					type="button"
					onClick={() => onPick('terminal')}
					className="flex-1 rounded border border-border bg-background px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.10em] text-foreground hover:border-foreground/60 hover:bg-foreground/5"
				>
					Terminal
				</button>
				<button
					type="button"
					onClick={() => onPick('sidepane')}
					className="flex-1 rounded border border-border bg-background px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.10em] text-foreground hover:border-foreground/60 hover:bg-foreground/5"
				>
					Sidepane
				</button>
			</div>
			<div className="border-t border-border px-2 py-1 font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground">
				override default sink
			</div>
		</div>
	);
}

interface FolderSettingsModalProps {
	path: string;
	settings: ArtifactGridSettings;
	onClose: () => void;
	onChanged: () => void;
}

function FolderSettingsModal({ path, settings, onClose, onChanged }: FolderSettingsModalProps) {
	const navigateFocused = usePaneStore((s) => s.navigateFocused);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') onClose();
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [onClose]);

	const onPickSink = async (v: DefaultSink | null) => {
		await setFolderDefaultSink(path, v);
		onChanged();
	};
	const onPickStack = async (v: StackMode | null) => {
		await setFolderStackMode(path, v);
		onChanged();
	};

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
			onMouseDown={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
		>
			<div
				className="w-[440px] max-w-[90vw] overflow-hidden rounded border border-border bg-background shadow-xl"
				onMouseDown={(e) => e.stopPropagation()}
			>
				<div className="flex items-center justify-between border-b border-border px-4 py-2.5">
					<div>
						<div className="text-xs font-semibold uppercase tracking-[0.18em] text-foreground">
							Folder settings
						</div>
						<div className="mt-0.5 font-mono text-[10px] text-muted-foreground">{path}</div>
					</div>
					<button
						type="button"
						onClick={onClose}
						className="text-xs text-muted-foreground hover:text-foreground"
					>
						✕
					</button>
				</div>

				<div className="divide-y divide-border">
					<FolderSettingRow
						label="Default sink"
						desc={`Pin clicks dispatch via this sink. Global default: ${settings.globalDefaultSink}.`}
						followGlobal={settings.folderDefaultSink === null}
						onFollow={() => onPickSink(null)}
					>
						<SinkSegments
							value={settings.folderDefaultSink ?? settings.globalDefaultSink}
							disabled={settings.folderDefaultSink === null}
							onChange={(v) => onPickSink(v)}
						/>
					</FolderSettingRow>
					<FolderSettingRow
						label="Stack mode"
						desc={`How variant stacks open. Global default: ${settings.globalStackMode}.`}
						followGlobal={settings.folderStackMode === null}
						onFollow={() => onPickStack(null)}
					>
						<StackSegments
							value={settings.folderStackMode ?? settings.globalStackMode}
							disabled={settings.folderStackMode === null}
							onChange={(v) => onPickStack(v)}
						/>
					</FolderSettingRow>
				</div>

				<div className="flex items-center justify-between border-t border-border bg-muted/20 px-4 py-2">
					<button
						type="button"
						onClick={() => {
							onClose();
							navigateFocused('/settings/artifact-grid');
						}}
						className="text-xs text-muted-foreground hover:text-foreground"
					>
						Edit global defaults →
					</button>
					<button
						type="button"
						onClick={onClose}
						className="rounded border border-border bg-background px-3 py-1 text-xs hover:bg-foreground/5"
					>
						Done
					</button>
				</div>
			</div>
		</div>
	);
}

interface FolderSettingRowProps {
	label: string;
	desc: string;
	followGlobal: boolean;
	onFollow: () => void;
	children: ReactNode;
}

function FolderSettingRow({
	label,
	desc,
	followGlobal,
	onFollow,
	children,
}: FolderSettingRowProps) {
	return (
		<div className="px-4 py-3">
			<div className="flex items-baseline justify-between gap-3">
				<div className="min-w-0">
					<div className="text-sm font-medium text-foreground">{label}</div>
					<div className="mt-0.5 text-xs text-muted-foreground">{desc}</div>
				</div>
				<label className="flex shrink-0 items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.10em] text-muted-foreground">
					<input
						type="checkbox"
						checked={followGlobal}
						onChange={onFollow}
						className="h-3 w-3 cursor-pointer"
					/>
					Follow global
				</label>
			</div>
			<div className="mt-2">{children}</div>
		</div>
	);
}

function SinkSegments({
	value,
	disabled,
	onChange,
}: {
	value: DefaultSink;
	disabled: boolean;
	onChange: (v: DefaultSink) => void;
}) {
	return (
		<div
			className={
				'inline-flex overflow-hidden rounded border border-border ' + (disabled ? 'opacity-50' : '')
			}
		>
			{(['auto', 'terminal', 'sidepane', 'both'] as const).map((opt) => (
				<button
					key={opt}
					type="button"
					disabled={disabled}
					onClick={() => onChange(opt)}
					className={
						'cursor-pointer border-r border-border px-3 py-1 text-xs capitalize last:border-r-0 disabled:cursor-default ' +
						(value === opt
							? 'bg-foreground/10 text-foreground'
							: 'text-muted-foreground hover:text-foreground')
					}
				>
					{opt}
				</button>
			))}
		</div>
	);
}

function StackSegments({
	value,
	disabled,
	onChange,
}: {
	value: StackMode;
	disabled: boolean;
	onChange: (v: StackMode) => void;
}) {
	return (
		<div
			className={
				'inline-flex overflow-hidden rounded border border-border ' + (disabled ? 'opacity-50' : '')
			}
		>
			{(['collapsed', 'expanded'] as const).map((opt) => (
				<button
					key={opt}
					type="button"
					disabled={disabled}
					onClick={() => onChange(opt)}
					className={
						'cursor-pointer border-r border-border px-3 py-1 text-xs capitalize last:border-r-0 disabled:cursor-default ' +
						(value === opt
							? 'bg-foreground/10 text-foreground'
							: 'text-muted-foreground hover:text-foreground')
					}
				>
					{opt}
				</button>
			))}
		</div>
	);
}

interface GridSidebarProps {
	activePin: { artifactPath: string; pin: Comment } | null;
	claudePty: { ptyId: string; name: string } | null;
	onResolve: (pinId: number) => void;
}

function GridSidebar({ activePin, claudePty, onResolve }: GridSidebarProps) {
	return (
		<aside className="flex flex-col overflow-y-auto border-l border-border bg-muted/20">
			<div className="border-b border-border px-4 py-2 font-mono text-[10px] font-bold uppercase tracking-[0.22em] text-muted-foreground">
				Pin → {claudePty ? 'Terminal claude' : 'Side-pane Chat (fallback)'}
			</div>
			{!activePin ? (
				<div className="p-5 font-mono text-xs leading-relaxed text-muted-foreground">
					click any comment pin on the left to dispatch it to{' '}
					{claudePty ? (
						<>
							your active <span className="text-amber-700">claude</span> PTY (term{' '}
							{claudePty.ptyId.slice(0, 6)}); claude reads the full payload via{' '}
							<span className="text-amber-700">mcp-iyke.read_pin</span>.
						</>
					) : (
						<>
							the side-pane <span className="text-amber-700">Chat</span> thread. Run{' '}
							<span className="text-amber-700">claude</span> in a terminal pane to switch routing to
							the terminal sink.
						</>
					)}
				</div>
			) : (
				<div className="p-4">
					<div className="space-y-2 font-mono text-xs">
						<Row k="Pin id" v={`#${activePin.pin.id} · ${activePin.pin.status}`} />
						<Row k="Artifact" v={activePin.pin.artifactPath.split('/').pop() ?? ''} />
						<Row k="Selector" v={activePin.pin.selector} highlight />
						<Row
							k="Screenshot"
							v={
								activePin.pin.screenshotPath
									? (activePin.pin.screenshotPath.split('/').pop() ?? '—')
									: '—'
							}
							muted
						/>
						<Row k="Sink" v={activePin.pin.sink ?? 'pending'} muted />
						<div className="mt-2 border-t border-border pt-2">
							<div className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
								Text
							</div>
							<div className="mt-1 italic text-foreground">"{activePin.pin.text}"</div>
						</div>
						{activePin.pin.status !== 'resolved' && (
							<button
								type="button"
								onClick={() => onResolve(activePin.pin.id)}
								className="mt-3 w-full rounded border border-emerald-700 bg-emerald-700/10 py-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-emerald-800 hover:bg-emerald-700/20"
							>
								Resolve pin
							</button>
						)}
					</div>
				</div>
			)}
		</aside>
	);
}

interface GridSidebarInboxProps {
	rows: InboxRow[];
	activePinId: number | null;
	claudePty: { ptyId: string; name: string } | null;
	onSelectAndRoute: (pin: Comment) => void;
	onResolve: (pinId: number) => void;
}

function GridSidebarInbox({
	rows,
	activePinId,
	claudePty,
	onSelectAndRoute,
	onResolve,
}: GridSidebarInboxProps) {
	const openCount = rows.filter((r) => r.pin.status === 'open').length;
	return (
		<aside className="flex flex-col overflow-y-auto border-l border-border bg-muted/20">
			<div className="flex items-baseline justify-between border-b border-border px-4 py-2">
				<span className="font-mono text-[10px] font-bold uppercase tracking-[0.22em] text-muted-foreground">
					Inbox
				</span>
				<span className="font-mono text-[10px] uppercase tracking-[0.10em] text-muted-foreground">
					<span className={openCount > 0 ? 'text-destructive font-bold' : ''}>{openCount}</span>
					<span className="opacity-60"> open · </span>
					<span>{rows.length} total</span>
				</span>
			</div>
			<div className="border-b border-border px-4 py-1.5 font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground">
				Pin → {claudePty ? 'Terminal claude' : 'Side-pane Chat (fallback)'}
			</div>
			<div className="flex-1 overflow-y-auto">
				{rows.map((row) => (
					<InboxRowItem
						key={row.pin.id}
						row={row}
						isActive={row.pin.id === activePinId}
						onClick={() => onSelectAndRoute(row.pin)}
						onResolve={() => onResolve(row.pin.id)}
					/>
				))}
			</div>
		</aside>
	);
}

interface InboxRowItemProps {
	row: InboxRow;
	isActive: boolean;
	onClick: () => void;
	onResolve: () => void;
}

function InboxRowItem({ row, isActive, onClick, onResolve }: InboxRowItemProps) {
	const { pin, numbering } = row;
	const tone =
		pin.status === 'open'
			? 'bg-red-600 text-white'
			: pin.status === 'in_progress'
				? 'bg-amber-500 text-white'
				: 'bg-emerald-700 text-white';
	const muted = pin.status === 'resolved' ? 'opacity-50' : '';
	const artifactName = pin.artifactPath.split('/').pop() ?? pin.artifactPath;
	return (
		<button
			type="button"
			onClick={onClick}
			className={
				'group grid w-full grid-cols-[20px_1fr_auto] items-start gap-2 border-b border-border/40 px-3 py-2 text-left transition-colors hover:bg-foreground/5 ' +
				(isActive ? 'bg-foreground/10' : '')
			}
		>
			<span
				className={`mt-0.5 flex h-4 w-4 items-center justify-center rounded-full border border-background font-mono text-[9px] font-bold ${tone} ${muted}`}
				title={pin.status}
			>
				{numbering}
			</span>
			<div className={'min-w-0 ' + muted}>
				<div className="flex items-baseline gap-1.5 font-mono text-[10px] uppercase tracking-[0.10em] text-muted-foreground">
					<span className="truncate text-foreground/80">{artifactName}</span>
					<span className="truncate normal-case text-destructive/80 tracking-normal">
						{pin.selector}
					</span>
				</div>
				<div className="mt-0.5 truncate text-xs text-foreground">{pin.text}</div>
			</div>
			{pin.status !== 'resolved' && (
				<span
					role="button"
					tabIndex={-1}
					onClick={(e) => {
						e.stopPropagation();
						onResolve();
					}}
					className="invisible self-center rounded border border-emerald-700 px-1.5 py-0.5 font-mono text-[8px] font-bold uppercase tracking-[0.10em] text-emerald-800 hover:bg-emerald-700/10 group-hover:visible"
					title="Mark resolved"
				>
					✓
				</span>
			)}
		</button>
	);
}

function Row({
	k,
	v,
	highlight,
	muted,
}: {
	k: string;
	v: string;
	highlight?: boolean;
	muted?: boolean;
}) {
	return (
		<div className="grid grid-cols-[76px_1fr] gap-2.5">
			<span className="pt-[3px] text-[9px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
				{k}
			</span>
			<span
				className={
					highlight
						? 'text-amber-700 font-mono'
						: muted
							? 'text-muted-foreground'
							: 'text-foreground'
				}
			>
				{v}
			</span>
		</div>
	);
}
