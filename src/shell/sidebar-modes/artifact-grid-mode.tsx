// Artifact-grid sidebar.
//
// Activated by the activity-bar Artifact-grid icon (⌘5). Body shows the
// recently-opened folders the user has been working in — same data as the
// activity-bar quick-launcher popover — plus a tools row for creating a new
// artifact or browsing to a fresh folder. A slim catalog stripe at the top
// (total, drafts, starred) is fed by the project-wide artifact walker.

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Folder, FolderOpen, Plus, Trash2 } from 'lucide-react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';

import { cn } from '@/components/ui/utils';
import { usePaneStore } from '@/lib/panes/pane-store';
import { projectArtifactsQueryOptions } from '@/lib/queries/project-artifacts';
import {
	type RecentGridFolder,
	loadRecents,
	openArtifactGrid,
	removeRecent,
	subscribeRecents,
} from '@/lib/shell/artifact-grid-recents';
import { useShellStore } from '@/lib/shell/shell-store';

export function ArtifactGridMode() {
	const navigateFocused = usePaneStore((s) => s.navigateFocused);
	const activeProject = useShellStore(
		(s) => s.projects.find((p) => p.id === s.activeProjectId) ?? null
	);

	const catalogQuery = useQuery(projectArtifactsQueryOptions(activeProject?.root_path ?? null));
	const counts = catalogQuery.data?.counts;

	const [recents, setRecents] = useState<RecentGridFolder[]>([]);
	const [hydrated, setHydrated] = useState(false);

	// Initial load + live subscription so the list refreshes when the
	// activity-bar popover (or any other surface) drops or re-orders an
	// entry while this mode is mounted.
	useEffect(() => {
		let cancelled = false;
		void loadRecents().then((next) => {
			if (!cancelled) {
				setRecents(next);
				setHydrated(true);
			}
		});
		const unsub = subscribeRecents(setRecents);
		return () => {
			cancelled = true;
			unsub();
		};
	}, []);

	async function open(path: string) {
		await openArtifactGrid(path);
	}

	async function drop(path: string) {
		await removeRecent(path);
	}

	async function browse() {
		try {
			const picked = await openDialog({ directory: true, multiple: false });
			if (typeof picked === 'string' && picked.length > 0) {
				await openArtifactGrid(picked);
			}
		} catch (e) {
			console.error('[artifact-grid] folder-picker failed', e);
		}
	}

	function openWizard() {
		navigateFocused('/projects/new-artifact');
	}

	function openProjectSettings() {
		navigateFocused('/settings/projects');
	}

	return (
		<div className="flex h-full flex-col">
			{/* Project chip — clickable header anchored to the active project. */}
			<button
				type="button"
				onClick={openProjectSettings}
				className="flex items-center gap-2 border-b border-border px-4 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
				title={activeProject?.root_path ?? 'No active project'}
			>
				<span
					aria-hidden
					className="inline-block h-2.5 w-2.5 shrink-0 rounded-full border border-border"
					style={{ background: activeProject?.color ?? '#7c7c7c' }}
				/>
				<span className="flex-1 truncate font-medium text-foreground">
					{activeProject?.display_name ?? 'No project'}
				</span>
				{activeProject?.root_path && (
					<span className="truncate font-mono text-[10px] opacity-70">
						{shortRoot(activeProject.root_path)}
					</span>
				)}
			</button>

			{/* Catalog stripe — total / drafts / starred across the project. */}
			{activeProject?.root_path && counts && (
				<div className="flex items-center gap-4 border-b border-border px-4 py-1.5 text-[10px] text-muted-foreground">
					<CountChip label="all" value={counts.all} />
					{counts.drafts > 0 && <CountChip label="drafts" value={counts.drafts} tone="warn" />}
					{counts.starred > 0 && <CountChip label="starred" value={counts.starred} />}
					{counts.recent > 0 && <CountChip label="recent" value={counts.recent} />}
				</div>
			)}

			{/* Recents — full-height body. */}
			<div className="flex-1 min-h-0 overflow-y-auto">
				<div className="px-4 pb-1 pt-3 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
					Recent
				</div>
				{!hydrated ? (
					<div className="px-4 py-2 text-xs italic text-muted-foreground">Loading…</div>
				) : recents.length === 0 ? (
					<div className="px-4 py-3 text-xs italic text-muted-foreground">
						No recent folders. Use{' '}
						<button
							type="button"
							onClick={() => void browse()}
							className="underline hover:text-foreground"
						>
							Browse folder…
						</button>{' '}
						to pick one.
					</div>
				) : (
					<ul className="flex flex-col">
						{recents.map((r) => (
							<RecentRow
								key={r.path}
								recent={r}
								onOpen={() => void open(r.path)}
								onDrop={() => void drop(r.path)}
							/>
						))}
					</ul>
				)}
			</div>

			{/* Tools row — pinned to the bottom of the sidebar. */}
			<div className="border-t border-border">
				<button
					type="button"
					onClick={openWizard}
					className={cn(
						'flex w-full items-center gap-3 px-4 py-2 text-left text-sm',
						'text-foreground transition-colors hover:bg-accent hover:text-accent-foreground'
					)}
				>
					<Plus className="h-4 w-4 shrink-0" />
					<span className="flex-1">New artifact</span>
					<span className="font-mono text-[10px] text-muted-foreground">⌘⇧N</span>
				</button>
				<button
					type="button"
					onClick={() => void browse()}
					className={cn(
						'flex w-full items-center gap-3 px-4 py-2 text-left text-sm',
						'text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground'
					)}
				>
					<FolderOpen className="h-4 w-4 shrink-0" />
					<span className="flex-1">Browse folder…</span>
				</button>
			</div>
		</div>
	);
}

function RecentRow({
	recent,
	onOpen,
	onDrop,
}: {
	recent: RecentGridFolder;
	onOpen: () => void;
	onDrop: () => void;
}) {
	const name = recent.path.replace(/\/+$/, '').replace(/^.+\//, '') || recent.path;
	return (
		<li className="group/recent flex items-center">
			<button
				type="button"
				onClick={onOpen}
				className="flex flex-1 min-w-0 items-center gap-2 px-4 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
				title={recent.path}
			>
				<Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
				<span className="flex-1 min-w-0 truncate">{name}</span>
				<span className="shrink-0 font-mono text-[10px] text-muted-foreground/70">
					{relativeOpenedAt(recent.openedAtMs)}
				</span>
			</button>
			<button
				type="button"
				onClick={onDrop}
				title="Remove from recents"
				aria-label="Remove from recents"
				className="invisible mr-2 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground group-hover/recent:visible"
			>
				<Trash2 className="h-3 w-3" />
			</button>
		</li>
	);
}

function CountChip({ label, value, tone }: { label: string; value: number; tone?: 'warn' }) {
	return (
		<span className="inline-flex items-baseline gap-1">
			<span
				className={cn(
					'font-mono text-[11px]',
					tone === 'warn' ? 'text-amber-600 dark:text-amber-400' : 'text-foreground'
				)}
			>
				{value}
			</span>
			<span className="uppercase tracking-wider text-muted-foreground/60">{label}</span>
		</span>
	);
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function relativeOpenedAt(ms: number): string {
	const delta = Date.now() - ms;
	const min = Math.round(delta / 60_000);
	if (min < 1) return 'now';
	if (min < 60) return `${min}m`;
	const hr = Math.round(min / 60);
	if (hr < 24) return `${hr}h`;
	const day = Math.round(hr / 24);
	if (day < 7) return `${day}d`;
	const wk = Math.round(day / 7);
	if (wk < 5) return `${wk}w`;
	const mo = Math.round(day / 30);
	return `${mo}mo`;
}

function shortRoot(root: string): string {
	const home = root.match(/^\/home\/[^/]+/)?.[0];
	if (home && root.startsWith(home)) return `~${root.slice(home.length)}`;
	return root;
}
