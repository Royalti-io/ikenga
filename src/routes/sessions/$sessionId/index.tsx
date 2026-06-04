import { useEffect, useMemo, useState } from 'react';
import { Link, createFileRoute, redirect, useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, FolderKanban, Loader2, Terminal } from 'lucide-react';
import { FeedbackState } from '@/components/ui/feedback-state';

import { detectAgentSlug, sessionsListQueryOptions } from '@/lib/queries/sessions';
import { shortPath, loadHome } from '@/lib/home';

import '../sessions.css';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { chatForkSession, chatLoadSession, chatThreadMove } from '@/lib/tauri-cmd';
import { useShellStore } from '@/lib/shell/shell-store';
import { createTerminalSession } from '@/terminal/single-terminal';
import { buildClaudeWrappedCmd } from '@/terminal/claude-wrap';
import { usePaneStore } from '@/lib/panes/pane-store';
import {
	AdapterSwitcher,
	Composer,
	Thread,
	selectTotalCostUsd,
	useChatStore,
	useThread,
	findThreadByClaudeSessionId,
} from '@/chat';

// Claude session ids are uuid v4: 8-4-4-4-12 hex with hyphens.
const CLAUDE_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function SessionDetailPage() {
	const { sessionId: threadId } = Route.useParams();
	const navigate = useNavigate();

	// Phase 8: ACP `session/load` — re-attach to the session by thread id
	// so the mode picker can hydrate without paying cold-spawn cost. The
	// claude child stays lazy; spawn happens on the next prompt. We
	// silently swallow "no session for thread" (expected for first-open
	// threads that haven't gone through `chatNewSession` yet) and only
	// surface loud errors via console.warn for real failures.
	useEffect(() => {
		let cancelled = false;
		void chatLoadSession(threadId).catch((err: unknown) => {
			if (cancelled) return;
			const msg = err instanceof Error ? err.message : String(err);
			if (msg.includes('no session for thread')) return;
			console.warn('chatLoadSession:', err);
		});
		return () => {
			cancelled = true;
		};
	}, [threadId]);

	// Phase 8: "Branch from here" handler. Forks the current thread at the
	// user-turn index of the clicked assistant message, then navigates to
	// the new thread so the user can continue in a separate Ikenga thread
	// that resumes from the same on-disk JSONL transcript.
	async function handleBranch(upToTurn: number) {
		try {
			const result = await chatForkSession(threadId, { upToTurn });
			void navigate({
				to: '/sessions/$sessionId',
				params: { sessionId: result.newThreadId },
			});
		} catch (e) {
			console.warn('chatForkSession:', e);
		}
	}

	// Bind this route's threadId to a chat thread. The hook hydrates the
	// store from SQLite + JSONL and asks the adapter to attach a live
	// subscription. threadId is stable for the thread's lifetime — no
	// placeholder→real navigate dance.
	const { loading, error } = useThread(threadId);
	const claudeSessionId = useChatStore((s) => s.threads[threadId]?.thread.claudeSessionId ?? null);
	const adapterId = useChatStore((s) => s.threads[threadId]?.thread.adapterId ?? null);
	// ADR-011 phase 1: cumulative thread cost — sum of `totalCostUsd` across
	// all `done` events so the user sees lifetime spend on the thread, not
	// just per-turn cost. Surfaces in the .ses-det-meta row below.
	const totalCostUsd = useChatStore((s) => {
		const events = s.threads[threadId]?.events ?? [];
		return selectTotalCostUsd(events);
	});
	// Hi-fi v2 header: turn count next to cost. User turns are the
	// canonical "exchange" count — assistant turns + tool calls are
	// follow-on. Count `user_turn` events; falls back to 0 on empty.
	const turnCount = useChatStore((s) => {
		const events = s.threads[threadId]?.events ?? [];
		let n = 0;
		for (const e of events) if (e.kind === 'user_turn') n++;
		return n;
	});
	const threadProjectId = useChatStore((s) => s.threads[threadId]?.thread.projectId ?? null);
	const projects = useShellStore((s) => s.projects);
	const threadProject = projects.find((p) => p.id === threadProjectId);
	const queryClient = useQueryClient();
	const [moveBusy, setMoveBusy] = useState(false);
	const [moveOpen, setMoveOpen] = useState(false);

	async function handleMoveProject(nextProjectId: string) {
		if (moveBusy || nextProjectId === threadProjectId) {
			setMoveOpen(false);
			return;
		}
		setMoveBusy(true);
		try {
			await chatThreadMove(threadId, nextProjectId);
			// Mirror locally so the chip reflects the new project without
			// waiting for a refetch round-trip.
			const t = useChatStore.getState().threads[threadId];
			if (t) {
				useChatStore.getState().upsertThread({ ...t.thread, projectId: nextProjectId }, t.events);
			}
			await queryClient.invalidateQueries({ queryKey: ['project-scoped'] });
			setMoveOpen(false);
		} catch (e) {
			console.warn('chatThreadMove:', e);
		} finally {
			setMoveBusy(false);
		}
	}

	const { data: list } = useQuery(sessionsListQueryOptions(null));
	const summary = useMemo(
		() => (claudeSessionId ? list?.find((s) => s.sessionId === claudeSessionId) : undefined),
		[list, claudeSessionId]
	);

	// Open `claude --resume <id>` in a fresh terminal tab in the focused
	// pane. The shell-wrapper (see claude-wrap.ts) keeps the PTY alive on
	// any claude failure mode and lets the user edit/retry the command.
	async function handleAttachTerminal() {
		// Resume id: the real claude session id captured from system:init. For
		// legacy 'cli'-adapter threads the threadId IS the claude session id
		// (the JSONL is named after it), so it's a valid fallback there. ACP
		// threads mint their own frontend uuid that is NOT a claude session —
		// resuming with it just fails ("No conversation found"), so when we
		// have no real id we open claude fresh instead of crashing.
		const resumeId = claudeSessionId ?? (adapterId === 'cli' ? threadId : null);
		const fallbackCwd = await loadHome();
		const sessionId = createTerminalSession({
			cwd: threadProject?.root_path ?? summary?.projectDir ?? fallbackCwd,
			cmd: buildClaudeWrappedCmd({ resumeSessionId: resumeId }),
			title: resumeId ? `claude · ${resumeId.slice(0, 8)}` : 'claude',
		});
		const focusedId = usePaneStore.getState().focusedId;
		usePaneStore.getState().addTab(focusedId, { kind: 'terminal', sessionId });
	}

	const agent = summary ? detectAgentSlug(summary) : null;
	const title = summary?.title ?? threadId;

	return (
		<div className="flex h-full flex-col">
			<div className="ses-det-head">
				<Link to="/sessions" className="ses-back-link">
					<ArrowLeft />
					All sessions
				</Link>
				<div className="ses-det-row">
					<div style={{ minWidth: 0, flex: 1 }}>
						<div className="ses-det-titlewrap">
							<Terminal style={{ width: 18, height: 18, color: 'var(--fg-muted)' }} />
							<h3 className="ses-det-title" title={title}>
								{title}
							</h3>
							{agent && (
								<span className="agent-badge" style={{ marginTop: 0 }}>
									<span className="dot" />
									{agent}
								</span>
							)}
							<Popover open={moveOpen} onOpenChange={setMoveOpen}>
								<PopoverTrigger asChild>
									<button
										type="button"
										className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-2 py-0.5 text-xs hover:bg-accent"
										title="Change project"
										disabled={moveBusy}
									>
										<FolderKanban className="h-3 w-3" />
										{threadProject?.color && (
											<span
												aria-hidden
												style={{
													display: 'inline-block',
													width: 8,
													height: 8,
													borderRadius: 999,
													background: threadProject.color,
												}}
											/>
										)}
										<span>{threadProject?.display_name ?? (threadProjectId || 'No project')}</span>
									</button>
								</PopoverTrigger>
								<PopoverContent align="start" className="w-64 p-1">
									{projects
										.filter((p) => !p.archived_at)
										.map((p) => (
											<button
												key={p.id}
												type="button"
												onClick={() => handleMoveProject(p.id)}
												disabled={moveBusy}
												className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent disabled:opacity-50 ${p.id === threadProjectId ? 'bg-accent/50' : ''}`}
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
												<span className="flex-1">{p.display_name}</span>
												{p.id === threadProjectId && <span aria-hidden>✓</span>}
											</button>
										))}
								</PopoverContent>
							</Popover>
						</div>
						<div className="ses-det-meta">
							{summary?.projectDir && <code>{shortPath(summary.projectDir)}</code>}
							{summary?.model && (
								<span className="model-badge">{summary.model.replace('claude-', '')}</span>
							)}
							{summary?.lastMessageAt && (
								<>
									<span className="sep">·</span>
									<span>last activity {new Date(summary.lastMessageAt).toLocaleString()}</span>
								</>
							)}
							<span className="sep">·</span>
							<span className="id">
								{threadId.slice(0, 8)}…{threadId.slice(-4)}
							</span>
							{claudeSessionId && (
								<>
									<span className="sep">·</span>
									<span className="id" title="Claude session id">
										claude {claudeSessionId.slice(0, 8)}…
									</span>
								</>
							)}
							{totalCostUsd > 0 && (
								<>
									<span className="sep">·</span>
									<span
										style={{
											color: 'var(--kola-amber)',
											fontFamily: 'var(--font-mono)',
											textTransform: 'uppercase',
											letterSpacing: '0.06em',
										}}
										title="Cumulative cost for this thread — sum of done.totalCostUsd"
									>
										spent ${totalCostUsd.toFixed(2)}
									</span>
								</>
							)}
							{turnCount > 0 && (
								<>
									<span className="sep">·</span>
									<span
										style={{
											fontFamily: 'var(--font-mono)',
											textTransform: 'uppercase',
											letterSpacing: '0.06em',
										}}
										title="Number of user turns in this thread"
									>
										{turnCount} turn{turnCount === 1 ? '' : 's'}
									</span>
								</>
							)}
						</div>
					</div>
					<div className="ses-det-actions">
						<AdapterSwitcher />
						<button
							type="button"
							onClick={handleAttachTerminal}
							className="inline-flex items-center gap-1 rounded-md border border-input bg-background px-3 py-1.5 text-xs hover:bg-accent"
							title="Open `claude --resume` for this conversation in a new terminal pane"
						>
							<Terminal className="h-3 w-3" />
							Open in terminal
						</button>
					</div>
				</div>
			</div>

			<div className="flex flex-1 flex-col overflow-hidden">
				{loading && (
					<div className="flex h-full items-center justify-center text-sm text-muted-foreground">
						<Loader2 className="mr-2 h-4 w-4 animate-spin" />
						Loading session events…
					</div>
				)}
				{error && (
					<FeedbackState
						variant="error"
						fill
						heading="Failed to load session"
						body={typeof error === 'string' ? error : String(error)}
					/>
				)}
				{!loading && !error && (
					<>
						<Thread threadId={threadId} className="flex-1" onBranch={handleBranch} />
						<Composer threadId={threadId} />
					</>
				)}
			</div>
		</div>
	);
}

export const Route = createFileRoute('/sessions/$sessionId/')({
	// Back-compat: when the param looks like a Claude UUID and we have a
	// thread row that owns it, redirect to /sessions/<threadId>. Old deep
	// links keep working. Else accept the param as a threadId.
	beforeLoad: async ({ params }) => {
		const id = params.sessionId;
		if (!CLAUDE_SESSION_ID_RE.test(id)) return;
		try {
			const thread = await findThreadByClaudeSessionId(id);
			if (thread && thread.id !== id) {
				throw redirect({
					to: '/sessions/$sessionId',
					params: { sessionId: thread.id },
					replace: true,
				});
			}
		} catch (e) {
			// Surface redirects; swallow lookup failures (we'll just render with
			// the Claude id as the threadId, which still works because the hook
			// mints a thread row for it).
			if (e && typeof e === 'object' && 'to' in e) throw e;
			console.debug('threadId redirect lookup failed:', e);
		}
	},
	component: SessionDetailPage,
});
