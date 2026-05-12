import { useEffect, useMemo } from 'react';
import { Link, createFileRoute, redirect, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { AlertCircle, ArrowLeft, Loader2, Terminal } from 'lucide-react';

import { detectAgentSlug, sessionsListQueryOptions } from '@/lib/queries/sessions';
import { shortPath, loadHome } from '@/lib/home';

import '../sessions.css';
import { acpForkSession, acpLoadSession } from '@/lib/tauri-cmd';
import { createTerminalSession } from '@/terminal/single-terminal';
import { buildClaudeWrappedCmd } from '@/terminal/claude-wrap';
import { usePaneStore } from '@/lib/panes/pane-store';
import {
	AdapterSwitcher,
	Composer,
	Thread,
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
	// threads that haven't gone through `acpNewSession` yet) and only
	// surface loud errors via console.warn for real failures.
	useEffect(() => {
		let cancelled = false;
		void acpLoadSession(threadId).catch((err: unknown) => {
			if (cancelled) return;
			const msg = err instanceof Error ? err.message : String(err);
			if (msg.includes('no session for thread')) return;
			console.warn('acpLoadSession:', err);
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
			const result = await acpForkSession(threadId, { upToTurn });
			void navigate({
				to: '/sessions/$sessionId',
				params: { sessionId: result.newThreadId },
			});
		} catch (e) {
			console.warn('acpForkSession:', e);
		}
	}

	// Bind this route's threadId to a chat thread. The hook hydrates the
	// store from SQLite + JSONL and asks the adapter to attach a live
	// subscription. threadId is stable for the thread's lifetime — no
	// placeholder→real navigate dance.
	const { loading, error } = useThread(threadId);
	const claudeSessionId = useChatStore((s) => s.threads[threadId]?.thread.claudeSessionId ?? null);

	const { data: list } = useQuery(sessionsListQueryOptions(null));
	const summary = useMemo(
		() => (claudeSessionId ? list?.find((s) => s.sessionId === claudeSessionId) : undefined),
		[list, claudeSessionId]
	);

	// Open `claude --resume <id>` in a fresh terminal tab in the focused
	// pane. The shell-wrapper (see claude-wrap.ts) keeps the PTY alive on
	// any claude failure mode and lets the user edit/retry the command.
	async function handleAttachTerminal() {
		// Resume id priority: the chat store's claudeSessionId (set when the
		// streaming child emitted system:init) → threadId (legacy sessions
		// where threadId IS the claude session id; the JSONL is named after it).
		const resumeId = claudeSessionId ?? threadId;
		const fallbackCwd = await loadHome();
		const sessionId = createTerminalSession({
			cwd: summary?.projectDir ?? fallbackCwd,
			cmd: buildClaudeWrappedCmd({ resumeSessionId: resumeId }),
			title: `claude · ${resumeId.slice(0, 8)}`,
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
					<div className="m-4 flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
						<AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
						<div>
							<p className="font-medium">Failed to load session</p>
							<p className="text-xs opacity-80">{error}</p>
						</div>
					</div>
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
