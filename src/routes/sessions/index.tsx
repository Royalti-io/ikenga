import { useEffect, useMemo, useState } from 'react';
import { Link, createFileRoute, useNavigate, useSearch } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import {
	AlertCircle,
	FolderKanban,
	Loader2,
	MessageSquare,
	Plus,
	Search,
	Terminal,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { chatThreadsByProjectQueryOptions, type ChatThreadSummary } from '@/lib/queries/sessions';
import { useShellStore } from '@/lib/shell/shell-store';
import { useThreadBadges } from '@/lib/shell/thread-badges-store';
import { shortPath } from '@/lib/home';
import { NewSessionDialog } from '@/shell/sessions/new-session-dialog';

import './sessions.css';

function formatRelative(ts: number | null | undefined): string {
	if (!ts) return '—';
	if (Number.isNaN(ts)) return '—';
	const ms = Date.now() - ts;
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	if (days < 30) return `${days}d ago`;
	return new Date(ts).toLocaleDateString();
}

const PAGE_SIZE = 50;

function SessionRow({
	thread,
	projectColor,
	badgeCount,
	onClearBadge,
}: {
	thread: ChatThreadSummary;
	projectColor: string | null;
	/** Phase 9: count of unread ACP user-attention pings (claude
	 *  `Notification` hooks + tool-approval requests) accumulated while the
	 *  user was elsewhere. Rendered as an orange dot + numeric count next
	 *  to the title. Cleared when the user clicks the row. */
	badgeCount: number;
	onClearBadge: () => void;
}) {
	const navigate = useNavigate();
	const hasTitle = !!thread.title && thread.title.trim().length > 0;
	const fallback = `${thread.id.slice(0, 8)}…${thread.id.slice(-4)}`;

	function handleRowClick(e: React.MouseEvent<HTMLTableRowElement>) {
		const target = e.target as HTMLElement;
		if (target.closest('a')) return;
		if (badgeCount > 0) onClearBadge();
		navigate({ to: '/sessions/$sessionId', params: { sessionId: thread.id } });
	}

	return (
		<tr onClick={handleRowClick}>
			<td>
				<div className="title-cell" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
					{projectColor && (
						<span
							aria-hidden
							style={{
								display: 'inline-block',
								width: 8,
								height: 8,
								borderRadius: 999,
								background: projectColor,
								flexShrink: 0,
							}}
						/>
					)}
					<Link
						to="/sessions/$sessionId"
						params={{ sessionId: thread.id }}
						className="truncate"
						title={hasTitle ? thread.title! : `Thread ${thread.id}`}
						style={{ color: 'var(--fg)', textDecoration: 'none' }}
						onClick={() => {
							if (badgeCount > 0) onClearBadge();
						}}
					>
						{hasTitle ? thread.title : <span className="session-id-fb">{fallback}</span>}
					</Link>
					{badgeCount > 0 && (
						<span
							className="thread-badge"
							title={`${badgeCount} unread notification${badgeCount === 1 ? '' : 's'}`}
							aria-label={`${badgeCount} unread`}
							style={{
								display: 'inline-flex',
								alignItems: 'center',
								gap: 4,
								marginLeft: 6,
								padding: '0 6px',
								borderRadius: 10,
								background: 'var(--accent, #f59e0b)',
								color: 'var(--accent-fg, #fff)',
								fontSize: 10,
								fontWeight: 600,
								lineHeight: '16px',
								minWidth: 16,
								justifyContent: 'center',
							}}
						>
							{badgeCount > 9 ? '9+' : badgeCount}
						</span>
					)}
				</div>
			</td>
			<td>
				<div className="muted" title={thread.cwd ?? ''}>
					{thread.cwd ? shortPath(thread.cwd) : '—'}
				</div>
			</td>
			<td className="muted">{formatRelative(thread.updated_at)}</td>
		</tr>
	);
}

function SessionsPage() {
	const navigate = useNavigate();
	const search = useSearch({ from: '/sessions/' }) as { new?: string };
	const [searchTerm, setSearch] = useState('');
	const [newDialogOpen, setNewDialogOpen] = useState(false);
	const [includeAll, setIncludeAll] = useState(false);
	const [limit, setLimit] = useState(PAGE_SIZE);

	const activeProjectId = useShellStore((s) => s.activeProjectId);
	const projects = useShellStore((s) => s.projects);
	const activeProject = projects.find((p) => p.id === activeProjectId);

	const badgeCounts = useThreadBadges((s) => s.counts);
	const clearBadge = useThreadBadges((s) => s.clear);

	useEffect(() => {
		if (search.new === '1' && !newDialogOpen) {
			setNewDialogOpen(true);
			navigate({ to: '/sessions', search: {}, replace: true });
		}
	}, [search.new, newDialogOpen, navigate]);

	const { data, isLoading, isFetching, error } = useQuery(
		chatThreadsByProjectQueryOptions(activeProjectId, includeAll, limit)
	);
	const hasMore = !!data && data.length >= limit;

	const projectColorById = useMemo(() => {
		const map = new Map<string, string | null>();
		for (const p of projects) map.set(p.id, p.color);
		return map;
	}, [projects]);

	const filtered = useMemo(() => {
		if (!data) return [] as ChatThreadSummary[];
		const q = searchTerm.trim().toLowerCase();
		if (!q) return data;
		return data.filter(
			(s) =>
				(s.title?.toLowerCase().includes(q) ?? false) ||
				s.id.toLowerCase().includes(q) ||
				(s.cwd?.toLowerCase().includes(q) ?? false)
		);
	}, [data, searchTerm]);

	return (
		<div className="flex h-full flex-col p-5">
			<div className="ses-frame flex-1">
				<div className="ses-list-head">
					<div>
						<h2>
							<Terminal className="h-mark" />
							Sessions
							{data && (
								<span className="count">
									({filtered.length}
									{filtered.length !== data.length && ` of ${data.length}`})
								</span>
							)}
						</h2>
						<div className="sub">
							Chat threads in the {includeAll ? 'workspace' : 'active project'}. Click a row to
							inspect; ⌘⇧N for a new session.
						</div>
					</div>
					<Button size="sm" onClick={() => setNewDialogOpen(true)}>
						<Plus className="h-3 w-3" />
						New session
						<span
							style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, opacity: 0.7, marginLeft: 6 }}
						>
							⌘⇧N
						</span>
					</Button>
				</div>

				<div className="ses-filterbar">
					<Popover>
						<PopoverTrigger asChild>
							<button
								type="button"
								className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-2.5 py-1 text-xs hover:bg-accent"
							>
								<FolderKanban className="h-3 w-3" />
								{includeAll ? (
									<span>All projects</span>
								) : (
									<>
										{activeProject?.color && (
											<span
												aria-hidden
												style={{
													display: 'inline-block',
													width: 8,
													height: 8,
													borderRadius: 999,
													background: activeProject.color,
												}}
											/>
										)}
										<span>{activeProject?.display_name ?? activeProjectId}</span>
									</>
								)}
							</button>
						</PopoverTrigger>
						<PopoverContent align="start" className="w-64 p-1">
							<button
								type="button"
								onClick={() => setIncludeAll(true)}
								className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent ${includeAll ? 'bg-accent/50' : ''}`}
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
										className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent ${!includeAll && p.id === activeProjectId ? 'bg-accent/50' : ''}`}
									>
										{p.color && (
											<span
												aria-hidden
												style={{
													display: 'inline-block',
													width: 8,
													height: 8,
													borderRadius: 999,
													background: p.color,
												}}
											/>
										)}
										<span>{p.display_name}</span>
									</button>
								))}
						</PopoverContent>
					</Popover>
					<div className="input-search-wrap">
						<Search />
						<input
							type="text"
							value={searchTerm}
							onChange={(e) => setSearch(e.target.value)}
							placeholder="Search title, thread id, dir…"
						/>
					</div>
					<div className="spacer" />
					<span className="label">
						{filtered.length} of {data?.length ?? 0}
					</span>
				</div>

				<div style={{ flex: 1, overflowY: 'auto' }}>
					{isLoading && (
						<div className="flex items-center gap-2 p-5 text-sm text-muted-foreground">
							<Loader2 className="h-4 w-4 animate-spin" />
							Loading threads…
						</div>
					)}
					{error instanceof Error && (
						<div className="m-5 flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
							<AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
							<div>
								<p className="font-medium">Failed to list sessions</p>
								<p className="text-xs opacity-80">{error.message}</p>
							</div>
						</div>
					)}
					{data && filtered.length === 0 && !isLoading && (
						<div className="m-5 flex h-32 items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
							<MessageSquare className="mr-2 h-4 w-4" />
							No sessions match.
						</div>
					)}
					{filtered.length > 0 && (
						<>
							<div className="ses-table-wrap">
								<table className="ses-table">
									<thead>
										<tr>
											<th>Title</th>
											<th style={{ width: 280 }}>Working dir</th>
											<th style={{ width: 140 }}>Last activity</th>
										</tr>
									</thead>
									<tbody>
										{filtered.map((thread) => {
											const badgeCount = badgeCounts[thread.id] ?? 0;
											const color = thread.project_id
												? (projectColorById.get(thread.project_id) ?? null)
												: null;
											return (
												<SessionRow
													key={thread.id}
													thread={thread}
													projectColor={color}
													badgeCount={badgeCount}
													onClearBadge={() => clearBadge(thread.id)}
												/>
											);
										})}
									</tbody>
								</table>
							</div>
							{hasMore && (
								<div
									style={{
										display: 'flex',
										justifyContent: 'center',
										padding: 'var(--space-3) 0 var(--space-5)',
									}}
								>
									<Button
										variant="outline"
										size="sm"
										onClick={() => setLimit((l) => l + PAGE_SIZE)}
										disabled={isFetching}
									>
										{isFetching ? (
											<>
												<Loader2 className="mr-2 h-3 w-3 animate-spin" />
												Loading…
											</>
										) : (
											`Load ${PAGE_SIZE} more`
										)}
									</Button>
								</div>
							)}
						</>
					)}
				</div>
			</div>

			<NewSessionDialog open={newDialogOpen} onOpenChange={setNewDialogOpen} />
		</div>
	);
}

export const Route = createFileRoute('/sessions/')({
	component: SessionsPage,
});
