import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
	ChevronDown,
	ChevronRight,
	Folder,
	FileText,
	AlertCircle,
	RefreshCw,
	Pencil,
	Trash2,
	MoreHorizontal,
} from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { useShellStore } from '@/lib/shell/shell-store';
import { useFilesStore } from '@/lib/shell/files-store';
import { usePaneStore } from '@/lib/panes/pane-store';
import { fsList, fsRename, fsTrash, type FileEntry } from '@/lib/tauri-cmd';
import { createTerminalSession } from '@/terminal/single-terminal';
import { queryKeys } from '@/lib/query-keys';
import { cn } from '@/components/ui/utils';
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

// Folders we never auto-list by default. The dot-file filter already catches
// `.git`, `.next`, `.cache`, `.turbo`, etc.; this catches the un-prefixed ones
// that can each hold tens of thousands of entries. Toggle off via the
// "Show ignored folders" view option (still lazy on expand).
const IGNORED_DIRS = new Set(['node_modules', 'target', 'dist', 'build', 'out']);

interface SortOptions {
	showHidden: boolean;
	showIgnored: boolean;
}

function sortEntries(list: FileEntry[], opts: SortOptions): FileEntry[] {
	const filtered = list.filter((e) => {
		if (!opts.showHidden && e.name.startsWith('.')) return false;
		if (!opts.showIgnored && e.isDir && IGNORED_DIRS.has(e.name)) return false;
		return true;
	});
	filtered.sort((a, b) => {
		if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
		return a.name.localeCompare(b.name);
	});
	return filtered;
}

function parentOf(p: string): string {
	const idx = p.lastIndexOf('/');
	return idx > 0 ? p.slice(0, idx) : p;
}

// 'right' splits horizontally (panes side by side), 'bottom' splits vertically
// (panes stacked). Matches the wording in the context menu.
type SplitMode = 'right' | 'bottom';

function openArtifactInSplit(path: string, mode: SplitMode) {
	// placeView with a split mode calls splitLeafAt under the hood — the new
	// leaf gets just the requested view, no clone of the active tab and no
	// cross-pane dedup. Using splitPane + addTab would clone the source pane's
	// active tab into the split AND run dedup that can steal focus back.
	const { focusedId, placeView } = usePaneStore.getState();
	placeView(focusedId, { kind: 'artifact', path }, mode);
}

function openTerminalAt(cwd: string, splitMode?: SplitMode) {
	const sessionId = createTerminalSession({ cwd });
	const view = { kind: 'terminal' as const, sessionId };
	const { focusedId, addTab, placeView } = usePaneStore.getState();
	if (splitMode) {
		placeView(focusedId, view, splitMode);
	} else {
		addTab(focusedId, view);
	}
}

interface TreeNodeProps {
	entry: FileEntry;
	depth: number;
}

function TreeNode({ entry, depth }: TreeNodeProps) {
	const expanded = useFilesStore((s) => s.expanded.has(entry.path));
	const isSelected = useFilesStore((s) => s.selectedPath === entry.path);
	const toggle = useFilesStore((s) => s.toggle);
	const collapse = useFilesStore((s) => s.collapse);
	const setSelected = useFilesStore((s) => s.setSelected);
	const prune = useFilesStore((s) => s.prune);
	const showHidden = useFilesStore((s) => s.showHidden);
	const showIgnored = useFilesStore((s) => s.showIgnored);
	const qc = useQueryClient();

	const [renaming, setRenaming] = useState(false);
	const [renameValue, setRenameValue] = useState(entry.name);
	const [actionError, setActionError] = useState<string | null>(null);
	const renameInputRef = useRef<HTMLInputElement | null>(null);

	// Re-create the select fn when flags change so the visible list updates
	// immediately. TanStack Query memoizes by reference, so we need a new fn
	// identity here.
	const selectSorted = useMemo(
		() => (list: FileEntry[]) => sortEntries(list, { showHidden, showIgnored }),
		[showHidden, showIgnored]
	);

	const childrenQuery = useQuery({
		queryKey: queryKeys.fs.list(entry.path),
		queryFn: () => fsList(entry.path),
		enabled: entry.isDir && expanded,
		staleTime: 30_000,
		select: selectSorted,
	});

	// If the directory disappeared, prune it from expanded so we don't
	// keep retrying on next mount.
	useEffect(() => {
		if (childrenQuery.isError && expanded) {
			prune([entry.path]);
		}
	}, [childrenQuery.isError, expanded, entry.path, prune]);

	const openFile = useCallback(() => {
		setSelected(entry.path);
		const focusedId = usePaneStore.getState().focusedId;
		usePaneStore.getState().addTab(focusedId, { kind: 'artifact', path: entry.path });
	}, [entry.path, setSelected]);

	const handleClick = useCallback(() => {
		if (renaming) return;
		if (entry.isDir) toggle(entry.path);
		else openFile();
	}, [entry.isDir, entry.path, renaming, toggle, openFile]);

	const startRename = useCallback(() => {
		setRenameValue(entry.name);
		setActionError(null);
		setRenaming(true);
	}, [entry.name]);

	useEffect(() => {
		if (renaming) {
			renameInputRef.current?.focus();
			renameInputRef.current?.select();
		}
	}, [renaming]);

	const commitRename = useCallback(async () => {
		const next = renameValue.trim();
		if (!next || next === entry.name) {
			setRenaming(false);
			return;
		}
		try {
			await fsRename(entry.path, next);
			setRenaming(false);
			// Path changed — drop the old path from expanded, refresh parent listing.
			prune([entry.path]);
			void qc.invalidateQueries({ queryKey: queryKeys.fs.list(parentOf(entry.path)) });
		} catch (err) {
			setActionError(err instanceof Error ? err.message : String(err));
		}
	}, [renameValue, entry.path, entry.name, prune, qc]);

	const handleDelete = useCallback(async () => {
		const ok = window.confirm(`Move "${entry.name}" to trash?`);
		if (!ok) return;
		try {
			await fsTrash(entry.path);
			prune([entry.path]);
			void qc.invalidateQueries({ queryKey: queryKeys.fs.list(parentOf(entry.path)) });
		} catch (err) {
			setActionError(err instanceof Error ? err.message : String(err));
		}
	}, [entry.path, entry.name, prune, qc]);

	const handleRefresh = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			if (!entry.isDir) return;
			if (!expanded) {
				toggle(entry.path);
				return;
			}
			void qc.invalidateQueries({ queryKey: queryKeys.fs.list(entry.path) });
		},
		[entry.isDir, entry.path, expanded, toggle, qc]
	);

	const children = childrenQuery.data;
	const error = childrenQuery.error
		? childrenQuery.error instanceof Error
			? childrenQuery.error.message
			: String(childrenQuery.error)
		: null;

	const terminalCwd = entry.isDir ? entry.path : parentOf(entry.path);
	const copyPath = useCallback(() => {
		void writeText(entry.path).catch(() => {});
	}, [entry.path]);

	return (
		<div>
			<ContextMenu>
				<ContextMenuTrigger asChild>
					<div
						className={cn(
							'group/row relative flex w-max min-w-full items-center text-xs transition-colors',
							'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
							isSelected && 'bg-accent text-accent-foreground font-medium'
						)}
					>
						<button
							type="button"
							onClick={handleClick}
							className="flex flex-1 items-center gap-1 whitespace-nowrap px-2 py-1 text-left"
							style={{ paddingLeft: `${Math.min(depth, 10) * 12 + 8}px` }}
							title={entry.path}
						>
							{entry.isDir ? (
								expanded ? (
									<ChevronDown className="h-3 w-3 shrink-0" />
								) : (
									<ChevronRight className="h-3 w-3 shrink-0" />
								)
							) : (
								<span className="h-3 w-3 shrink-0" aria-hidden />
							)}
							{entry.isDir ? (
								<Folder className="h-3.5 w-3.5 shrink-0" />
							) : (
								<FileText className="h-3.5 w-3.5 shrink-0" />
							)}
							{renaming ? (
								<input
									ref={renameInputRef}
									value={renameValue}
									onChange={(e) => setRenameValue(e.target.value)}
									onClick={(e) => e.stopPropagation()}
									onKeyDown={(e) => {
										if (e.key === 'Enter') {
											e.preventDefault();
											void commitRename();
										} else if (e.key === 'Escape') {
											e.preventDefault();
											setRenaming(false);
										}
									}}
									onBlur={() => void commitRename()}
									className="w-full min-w-0 rounded border border-border bg-background px-1 py-0 text-xs text-foreground outline-none focus:border-ring"
								/>
							) : (
								<span className="whitespace-nowrap">{entry.name}</span>
							)}
						</button>
						{!renaming && (
							<div className="absolute right-1 top-1/2 hidden -translate-y-1/2 items-center gap-0.5 rounded bg-accent pl-1 group-hover/row:flex">
								{entry.isDir && (
									<button
										type="button"
										onClick={handleRefresh}
										className="rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
										title="Refresh"
										aria-label="Refresh"
									>
										<RefreshCw className="h-3 w-3" />
									</button>
								)}
								<button
									type="button"
									onClick={(e) => {
										e.stopPropagation();
										startRename();
									}}
									className="rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
									title="Rename"
									aria-label="Rename"
								>
									<Pencil className="h-3 w-3" />
								</button>
								<button
									type="button"
									onClick={(e) => {
										e.stopPropagation();
										void handleDelete();
									}}
									className="rounded p-0.5 text-muted-foreground hover:bg-background hover:text-destructive"
									title="Move to trash"
									aria-label="Move to trash"
								>
									<Trash2 className="h-3 w-3" />
								</button>
							</div>
						)}
					</div>
				</ContextMenuTrigger>
				<ContextMenuContent>
					{!entry.isDir && (
						<>
							<ContextMenuItem onSelect={() => openFile()}>Open</ContextMenuItem>
							<ContextMenuItem onSelect={() => openArtifactInSplit(entry.path, 'right')}>
								Open to the Side
							</ContextMenuItem>
							<ContextMenuItem onSelect={() => openArtifactInSplit(entry.path, 'bottom')}>
								Open Below
							</ContextMenuItem>
							<ContextMenuSeparator />
						</>
					)}
					{entry.isDir && (
						<>
							<ContextMenuItem onSelect={() => openTerminalAt(terminalCwd)}>
								Open in Terminal
							</ContextMenuItem>
							<ContextMenuItem onSelect={() => openTerminalAt(terminalCwd, 'right')}>
								Open in Terminal to the Side
							</ContextMenuItem>
							<ContextMenuItem onSelect={() => openTerminalAt(terminalCwd, 'bottom')}>
								Open in Terminal Below
							</ContextMenuItem>
							<ContextMenuSeparator />
						</>
					)}
					<ContextMenuItem onSelect={copyPath}>Copy Path</ContextMenuItem>
					<ContextMenuItem onSelect={() => void writeText(entry.name).catch(() => {})}>
						Copy Name
					</ContextMenuItem>
					<ContextMenuSeparator />
					<ContextMenuItem onSelect={() => startRename()}>Rename…</ContextMenuItem>
					<ContextMenuItem variant="destructive" onSelect={() => void handleDelete()}>
						Move to Trash
					</ContextMenuItem>
				</ContextMenuContent>
			</ContextMenu>
			{actionError && (
				<div
					className="flex items-start gap-1 px-2 py-1 text-xs text-destructive"
					style={{ paddingLeft: `${Math.min(depth, 10) * 12 + 8}px` }}
				>
					<AlertCircle className="h-3 w-3 shrink-0 mt-0.5" />
					<span className="truncate" title={actionError}>
						{actionError}
					</span>
				</div>
			)}
			{entry.isDir && expanded && (
				<div>
					{error && (
						<div
							className="flex items-start gap-1 px-2 py-1 text-xs text-destructive"
							style={{ paddingLeft: `${Math.min(depth + 1, 10) * 12 + 8}px` }}
						>
							<AlertCircle className="h-3 w-3 shrink-0 mt-0.5" />
							<span className="truncate" title={error}>
								{error}
							</span>
							<button
								type="button"
								onClick={() => collapse(entry.path)}
								className="ml-auto rounded px-1 text-muted-foreground hover:bg-background"
							>
								hide
							</button>
						</div>
					)}
					{children?.map((child) => (
						<TreeNode key={child.path} entry={child} depth={depth + 1} />
					))}
					{children && children.length === 0 && !error && (
						<div
							className="px-2 py-1 text-xs text-muted-foreground italic"
							style={{ paddingLeft: `${Math.min(depth + 1, 10) * 12 + 8}px` }}
						>
							empty
						</div>
					)}
				</div>
			)}
		</div>
	);
}

interface RootSectionProps {
	rootPath: string;
}

function RootSection({ rootPath }: RootSectionProps) {
	const qc = useQueryClient();
	const showHidden = useFilesStore((s) => s.showHidden);
	const showIgnored = useFilesStore((s) => s.showIgnored);
	const selectSorted = useMemo(
		() => (list: FileEntry[]) => sortEntries(list, { showHidden, showIgnored }),
		[showHidden, showIgnored]
	);
	const rootQuery = useQuery({
		queryKey: queryKeys.fs.list(rootPath),
		queryFn: () => fsList(rootPath),
		staleTime: 30_000,
		select: selectSorted,
	});

	const reload = useCallback(() => {
		void qc.invalidateQueries({ queryKey: queryKeys.fs.list(rootPath) });
	}, [qc, rootPath]);

	const displayName = rootPath.replace(/^.+\//, '') || rootPath;
	const error = rootQuery.error
		? rootQuery.error instanceof Error
			? rootQuery.error.message
			: String(rootQuery.error)
		: null;
	const entries = rootQuery.data;

	return (
		<div className="border-b border-border last:border-b-0">
			<div className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-background px-3 py-1.5">
				<div className="flex min-w-0 items-center gap-1.5">
					<span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
						{displayName}
					</span>
				</div>
				<button
					type="button"
					onClick={reload}
					className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
					title={`Reload ${rootPath}`}
					aria-label="Reload"
				>
					<RefreshCw className="h-3 w-3" />
				</button>
			</div>
			{error && (
				<div className="flex items-start gap-1 px-3 py-1 text-xs text-destructive">
					<AlertCircle className="h-3 w-3 shrink-0 mt-0.5" />
					<span className="break-all" title={error}>
						{error}
					</span>
				</div>
			)}
			{!entries && !error && (
				<div className="px-3 py-1 text-xs text-muted-foreground italic">loading…</div>
			)}
			{entries?.map((entry) => (
				<TreeNode key={entry.path} entry={entry} depth={0} />
			))}
		</div>
	);
}

export function FilesMode() {
	const fileRoots = useShellStore((s) => s.fileRoots);
	const activeProjectId = useShellStore((s) => s.activeProjectId);
	const hydrated = useFilesStore((s) => s.hydrated);
	const hydrate = useFilesStore((s) => s.hydrate);
	const storedScrollTop = useFilesStore((s) => s.scrollTop);
	const setScrollTop = useFilesStore((s) => s.setScrollTop);
	const showHidden = useFilesStore((s) => s.showHidden);
	const showIgnored = useFilesStore((s) => s.showIgnored);
	const setShowHidden = useFilesStore((s) => s.setShowHidden);
	const setShowIgnored = useFilesStore((s) => s.setShowIgnored);
	const toggleShowHidden = useFilesStore((s) => s.toggleShowHidden);
	const scrollerRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		void hydrate(activeProjectId);
	}, [hydrate, activeProjectId]);

	// Cmd+. (Mac) / Ctrl+. (Linux/Windows) → toggle hidden files. Matches the
	// Finder convention. Bare `.` (no modifier) is left alone so users can
	// still type into rename inputs and search boxes. Scoped to keypresses
	// outside text inputs, same gating as the activity-bar shortcuts.
	useEffect(() => {
		function onKey(e: KeyboardEvent) {
			const mod = e.metaKey || e.ctrlKey;
			if (!mod || e.shiftKey || e.altKey) return;
			if (e.key !== '.') return;
			const target = e.target as HTMLElement | null;
			if (target?.matches('input, textarea, [contenteditable="true"]')) return;
			e.preventDefault();
			toggleShowHidden();
		}
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [toggleShowHidden]);

	// Restore scroll once on hydrate. Re-apply after a beat so late-resolving
	// queries that grow the tree don't clobber it. Intentionally only run on the
	// hydrate transition — not on every scroll.
	// biome-ignore lint/correctness/useExhaustiveDependencies: storedScrollTop is read fresh from the closure but we deliberately don't re-run on every scroll-save.
	useLayoutEffect(() => {
		if (!hydrated || !scrollerRef.current) return;
		const el = scrollerRef.current;
		el.scrollTop = storedScrollTop;
		const t = window.setTimeout(() => {
			el.scrollTop = storedScrollTop;
		}, 200);
		return () => window.clearTimeout(t);
	}, [hydrated]);

	const scrollSaveRef = useRef<number | null>(null);
	const onScroll = useCallback(() => {
		if (!scrollerRef.current) return;
		const top = scrollerRef.current.scrollTop;
		if (scrollSaveRef.current !== null) window.clearTimeout(scrollSaveRef.current);
		scrollSaveRef.current = window.setTimeout(() => {
			setScrollTop(top);
		}, 150);
	}, [setScrollTop]);

	return (
		<div className="flex h-full flex-col">
			<div className="flex items-center justify-between border-b border-border px-3 py-1.5">
				<span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
					Files
				</span>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<button
							type="button"
							className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
							title="View options"
							aria-label="View options"
						>
							<MoreHorizontal className="h-3.5 w-3.5" />
						</button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" className="w-56">
						<DropdownMenuCheckboxItem
							checked={showHidden}
							onCheckedChange={(v) => setShowHidden(Boolean(v))}
						>
							Show hidden files
							<span className="ml-auto text-[10px] text-muted-foreground">⌘.</span>
						</DropdownMenuCheckboxItem>
						<DropdownMenuCheckboxItem
							checked={showIgnored}
							onCheckedChange={(v) => setShowIgnored(Boolean(v))}
						>
							Show ignored folders
						</DropdownMenuCheckboxItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
			<div ref={scrollerRef} onScroll={onScroll} className="flex-1 overflow-auto">
				{fileRoots.length === 0 && (
					<div className="p-4 text-xs text-muted-foreground">
						No file roots configured. Add one from{' '}
						<span className="font-medium text-foreground">Settings</span>.
					</div>
				)}
				{fileRoots.map((root) => (
					<RootSection key={root} rootPath={root} />
				))}
			</div>
		</div>
	);
}
