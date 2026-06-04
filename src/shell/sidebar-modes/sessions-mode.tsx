import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
	AlertCircle,
	FolderKanban,
	Loader2,
	MessageSquare,
	Plus,
	SquareTerminal,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ListRow, UnreadBadge } from '@/components/ui/list-row';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/components/ui/utils';
import { shortPath } from '@/lib/home';
import { usePaneStore } from '@/lib/panes/pane-store';
import { chatThreadsByProjectQueryOptions, type ChatThreadSummary } from '@/lib/queries/sessions';
import { useShellStore } from '@/lib/shell/shell-store';
import { useThreadBadges } from '@/lib/shell/thread-badges-store';
import { NewSessionDialog } from '@/shell/sessions/new-session-dialog';

const SIDEBAR_LIMIT = 25;

function formatRelative(ts: number | null | undefined): string {
	if (!ts || Number.isNaN(ts)) return '—';
	const ms = Date.now() - ts;
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	if (days < 30) return `${days}d`;
	return new Date(ts).toLocaleDateString();
}

interface ThreadRowProps {
	thread: ChatThreadSummary;
	projectColor: string | null;
	badgeCount: number;
	onSelect: (thread: ChatThreadSummary) => void;
}

function ThreadRow({ thread, projectColor, badgeCount, onSelect }: ThreadRowProps) {
	const hasTitle = !!thread.title && thread.title.trim().length > 0;
	const fallback = `${thread.id.slice(0, 8)}…${thread.id.slice(-4)}`;
	const title = hasTitle ? thread.title! : fallback;
	const subtitle = thread.cwd ? shortPath(thread.cwd) : '';

	return (
		<ListRow
			size="md"
			onActivate={() => onSelect(thread)}
			title={`${title}${subtitle ? `\n${subtitle}` : ''}`}
			aria-label={badgeCount > 0 ? `${title}, ${badgeCount} unread` : title}
			icon={
				projectColor ? (
					<span
						aria-hidden
						className="h-2 w-2 shrink-0 rounded-full"
						style={{ background: projectColor }}
					/>
				) : (
					<span aria-hidden className="h-2 w-2 shrink-0" />
				)
			}
			name={title}
			subtitle={subtitle || undefined}
			badge={<UnreadBadge count={badgeCount} />}
			timestamp={formatRelative(thread.updated_at)}
		/>
	);
}

export function SessionsMode() {
	const [newDialogOpen, setNewDialogOpen] = useState(false);
	const [includeAll, setIncludeAll] = useState(false);

	const activeProjectId = useShellStore((s) => s.activeProjectId);
	const projects = useShellStore((s) => s.projects);
	const activeProject = projects.find((p) => p.id === activeProjectId);

	const badgeCounts = useThreadBadges((s) => s.counts);
	const clearBadge = useThreadBadges((s) => s.clear);

	const { data, isLoading, error } = useQuery(
		chatThreadsByProjectQueryOptions(activeProjectId, includeAll, SIDEBAR_LIMIT)
	);

	const projectColorById = useMemo(() => {
		const map = new Map<string, string | null>();
		for (const p of projects) map.set(p.id, p.color);
		return map;
	}, [projects]);

	function openThread(thread: ChatThreadSummary) {
		const badgeCount = badgeCounts[thread.id] ?? 0;
		if (badgeCount > 0) clearBadge(thread.id);
		usePaneStore.getState().navigateFocused(`/sessions/${thread.id}`);
	}

	function openAllSessions() {
		usePaneStore.getState().navigateFocused('/sessions');
	}

	return (
		<div className="flex h-full flex-col">
			<div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5">
				<span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
					Sessions
				</span>
				<div className="flex items-center gap-1">
					<Popover>
						<PopoverTrigger asChild>
							<button
								type="button"
								className="flex items-center gap-1 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
								title="Filter by project"
								aria-label="Filter by project"
							>
								<FolderKanban className="h-3 w-3" />
							</button>
						</PopoverTrigger>
						<PopoverContent align="end" className="w-56 p-1">
							<button
								type="button"
								onClick={() => setIncludeAll(true)}
								className={cn(
									'flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent',
									includeAll && 'bg-accent/50'
								)}
							>
								<span>All projects</span>
								{includeAll && <span aria-hidden>✓</span>}
							</button>
							<div className="my-1 border-t" />
							{projects
								.filter((p) => !p.archived_at)
								.map((p) => (
									<button
										key={p.id}
										type="button"
										onClick={() => setIncludeAll(false)}
										className={cn(
											'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent',
											!includeAll && p.id === activeProjectId && 'bg-accent/50'
										)}
									>
										{p.color && (
											<span
												aria-hidden
												className="inline-block h-2 w-2 rounded-full"
												style={{ background: p.color }}
											/>
										)}
										<span className="truncate">{p.display_name}</span>
									</button>
								))}
						</PopoverContent>
					</Popover>
					<button
						type="button"
						onClick={() => setNewDialogOpen(true)}
						className="flex items-center gap-1 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
						title="New session (⌘⇧N)"
						aria-label="New session"
					>
						<Plus className="h-3.5 w-3.5" />
					</button>
				</div>
			</div>

			<div className="border-b border-border px-3 py-1 text-[10px] text-muted-foreground">
				{includeAll ? (
					'All projects'
				) : (
					<span className="flex items-center gap-1.5">
						{activeProject?.color && (
							<span
								aria-hidden
								className="inline-block h-1.5 w-1.5 rounded-full"
								style={{ background: activeProject.color }}
							/>
						)}
						<span className="truncate">
							{activeProject?.display_name ?? activeProjectId ?? '—'}
						</span>
					</span>
				)}
			</div>

			<div className="flex-1 overflow-auto">
				{isLoading && (
					<div className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
						<Loader2 className="h-3 w-3 animate-spin" />
						Loading…
					</div>
				)}
				{error instanceof Error && (
					<div className="m-3 flex items-start gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-[11px] text-destructive">
						<AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
						<div className="min-w-0">
							<div className="font-medium">Failed to load</div>
							<div className="truncate opacity-80" title={error.message}>
								{error.message}
							</div>
						</div>
					</div>
				)}
				{data && data.length === 0 && !isLoading && (
					<div className="flex flex-col items-center justify-center gap-2 px-4 py-8 text-center">
						<MessageSquare className="h-6 w-6 text-muted-foreground/40" />
						<div className="text-xs text-muted-foreground">No sessions yet</div>
						<Button size="sm" variant="ghost" onClick={() => setNewDialogOpen(true)}>
							<Plus className="h-3 w-3" />
							New session
						</Button>
					</div>
				)}
				{data && data.length > 0 && (
					<div className="flex flex-col py-1">
						{data.map((thread) => {
							const color = thread.project_id
								? (projectColorById.get(thread.project_id) ?? null)
								: null;
							return (
								<ThreadRow
									key={thread.id}
									thread={thread}
									projectColor={color}
									badgeCount={badgeCounts[thread.id] ?? 0}
									onSelect={openThread}
								/>
							);
						})}
					</div>
				)}
			</div>

			{data && data.length > 0 && (
				<button
					type="button"
					onClick={openAllSessions}
					className="flex items-center justify-center gap-1.5 border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
				>
					<SquareTerminal className="h-3 w-3" />
					View all sessions
				</button>
			)}

			<NewSessionDialog open={newDialogOpen} onOpenChange={setNewDialogOpen} />
		</div>
	);
}
