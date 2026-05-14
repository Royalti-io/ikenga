import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Loader2, MessageSquare, Terminal } from 'lucide-react';

import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { mintThreadId, useChatActions, useChatStore } from '@/chat';
import { createThread } from '@/chat';
import { defaultCwd } from '@/lib/shell/default-cwd';
import { useShellStore } from '@/lib/shell/shell-store';
import { sessionEnsure } from '@/lib/tauri-cmd';
import { createTerminalSession } from '@/terminal/single-terminal';
import { buildClaudeWrappedCmd } from '@/terminal/claude-wrap';
import { usePaneStore } from '@/lib/panes/pane-store';

type Mode = 'chat' | 'terminal';

interface NewSessionDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	defaultProjects?: string[];
	/** Pre-filled prompt — used by /claude "New session" buttons that target a
	 *  specific agent or run a command body. */
	presetPrompt?: string;
	/** Which mode to default to. Most callers want 'chat' now; the legacy
	 *  /sessions list still defaults to 'chat' too. */
	defaultMode?: Mode;
}

export function NewSessionDialog({
	open,
	onOpenChange,
	defaultProjects = [],
	presetPrompt,
	defaultMode = 'chat',
}: NewSessionDialogProps) {
	const navigate = useNavigate();

	// When the caller doesn't pass project candidates, fall back to the
	// user's configured file roots (empty on fresh installs — the project
	// input becomes blank and the user types one in).
	const fileRoots = useShellStore((s) => s.fileRoots);
	const projects = defaultProjects.length > 0 ? defaultProjects : fileRoots;
	const activeProjectId = useShellStore((s) => s.activeProjectId);
	const shellProjects = useShellStore((s) => s.projects);
	const activeProject = shellProjects.find((p) => p.id === activeProjectId);
	const [projectId, setProjectId] = useState<string>(activeProjectId);
	const [project, setProject] = useState<string>(projects[0] ?? '');
	const [prompt, setPrompt] = useState('');
	const [mode, setMode] = useState<Mode>(defaultMode);
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string | null>(null);

	useEffect(() => {
		if (open) {
			// Pre-fill the working dir with the active project's root_path when
			// it's set; otherwise fall back to the first configured file root.
			// User can override either via the project picker (rebinds to a
			// different project's root) or by editing the dir directly.
			const root = activeProject?.root_path ?? null;
			setProject(root ?? projects[0] ?? '');
			setProjectId(activeProjectId);
			setPrompt(presetPrompt ?? '');
			setMode(defaultMode);
			setErr(null);
		}
	}, [open, projects, presetPrompt, defaultMode, activeProject?.root_path, activeProjectId]);

	async function handleStartChat() {
		if (!project) return;
		setBusy(true);
		setErr(null);
		try {
			const threadId = mintThreadId();
			await createThread({
				id: threadId,
				adapterId: 'cli',
				cwd: project,
				claudeSessionId: null,
				model: null,
				title: prompt.trim().slice(0, 80) || null,
				projectId,
			});
			await sessionEnsure(threadId, project, {});
			onOpenChange(false);
			navigate({ to: '/sessions/$sessionId', params: { sessionId: threadId } });
			// If the user pre-filled a prompt, kick it off immediately. We need
			// to wait one tick for the route to mount + the hook to hydrate the
			// store entry before the adapter can find it.
			if (prompt.trim()) {
				queueMicrotask(() => {
					void sendFirstPrompt(threadId, prompt);
				});
			}
		} catch (e) {
			setErr(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	}

	function handleOpenTerminal() {
		if (!project) return;
		const trimmed = prompt.trim();
		const sessionId = createTerminalSession({
			cwd: project,
			cmd: buildClaudeWrappedCmd({ prompt: trimmed || undefined }),
			title: trimmed ? `claude · ${trimmed.slice(0, 32)}` : 'claude',
		});
		const focusedId = usePaneStore.getState().focusedId;
		usePaneStore.getState().addTab(focusedId, { kind: 'terminal', sessionId });
		onOpenChange(false);
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>New session</DialogTitle>
					<DialogDescription>
						Start a streaming chat thread, or open Claude in a terminal.
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-4 py-2">
					<div className="flex items-center gap-2 text-xs">
						<span className="text-muted-foreground">Project:</span>
						<span className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-2 py-0.5">
							{(() => {
								const selected = shellProjects.find((p) => p.id === projectId);
								return (
									<>
										{selected?.color && (
											<span
												aria-hidden
												style={{
													display: 'inline-block',
													width: 8,
													height: 8,
													borderRadius: 999,
													background: selected.color,
												}}
											/>
										)}
										<span>{selected?.display_name ?? projectId}</span>
									</>
								);
							})()}
						</span>
						<select
							value={projectId}
							onChange={(e) => {
								const next = e.target.value;
								setProjectId(next);
								const np = shellProjects.find((p) => p.id === next);
								if (np?.root_path) setProject(np.root_path);
							}}
							className="rounded-md border border-input bg-background px-2 py-0.5 text-xs"
							aria-label="Change project"
						>
							{shellProjects
								.filter((p) => !p.archived_at)
								.map((p) => (
									<option key={p.id} value={p.id}>
										{p.display_name}
									</option>
								))}
						</select>
					</div>
					<div className="grid grid-cols-2 gap-2">
						<ModeChoice
							active={mode === 'chat'}
							onClick={() => setMode('chat')}
							Icon={MessageSquare}
							label="Chat"
							detail="streaming, in-app"
						/>
						<ModeChoice
							active={mode === 'terminal'}
							onClick={() => setMode('terminal')}
							Icon={Terminal}
							label="Terminal"
							detail="PTY, claude TUI"
						/>
					</div>

					<label className="block space-y-1.5">
						<span className="text-xs font-medium text-muted-foreground">Project directory</span>
						<select
							value={project}
							onChange={(e) => setProject(e.target.value)}
							className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
						>
							{projects.map((p) => (
								<option key={p} value={p}>
									{p}
								</option>
							))}
						</select>
					</label>

					<label className="block space-y-1.5">
						<span className="text-xs font-medium text-muted-foreground">
							Initial prompt <span className="text-muted-foreground/70">(optional)</span>
						</span>
						<textarea
							value={prompt}
							onChange={(e) => setPrompt(e.target.value)}
							rows={4}
							placeholder={
								mode === 'chat'
									? 'Leave blank to open an empty chat'
									: 'Leave blank to open the interactive TUI'
							}
							className="w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
						/>
					</label>

					{err && <p className="text-xs text-destructive">{err}</p>}
				</div>

				<DialogFooter>
					<Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					{mode === 'chat' ? (
						<Button type="button" onClick={handleStartChat} disabled={busy || !project}>
							{busy && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
							Start chat
						</Button>
					) : (
						<Button type="button" onClick={handleOpenTerminal} disabled={!project}>
							Open terminal
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function ModeChoice({
	active,
	onClick,
	Icon,
	label,
	detail,
}: {
	active: boolean;
	onClick: () => void;
	Icon: typeof MessageSquare;
	label: string;
	detail: string;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={
				'flex flex-col items-start gap-1 rounded-md border px-3 py-2 text-left transition-colors ' +
				(active ? 'border-primary bg-primary/5' : 'border-input bg-background hover:bg-accent')
			}
		>
			<div className="flex items-center gap-2 text-sm font-medium">
				<Icon className="h-3.5 w-3.5" />
				{label}
			</div>
			<span className="text-[11px] text-muted-foreground">{detail}</span>
		</button>
	);
}

/** Kick off the dialog's pre-filled prompt as soon as the route mounts. We
 *  poll the store for the thread entry (created by `useThread`) before
 *  invoking `send`. Bails after ~1s if the hydrate never lands. */
async function sendFirstPrompt(threadId: string, prompt: string) {
	for (let i = 0; i < 20; i++) {
		const t = useChatStore.getState().threads[threadId];
		if (t) break;
		await new Promise((r) => setTimeout(r, 50));
	}
	// Build a minimal action handle and call send directly. Reusing
	// useChatActions would require a React tree — we just want the side
	// effect.
	// Phase 10: resolve the adapter via the registry (defaults to ACP) instead
	// of hardcoding the legacy CLI path. The thread's persisted adapterId is
	// the source of truth; new threads use whatever `defaultChatAdapterId()`
	// returns at create time.
	const { getAdapter } = await import('../../chat/registry');
	const { appendUserTurn } = await import('../../chat/persist');
	const { defaultChatAdapterId } = await import('../../chat/default-adapter');
	const turn = await appendUserTurn(threadId, prompt);
	useChatStore.getState().appendEvents(threadId, [
		{
			kind: 'user_turn',
			text: turn.text,
			sequence: turn.sequence,
			createdAt: turn.createdAt,
		},
	]);
	const threadEntry = useChatStore.getState().threads[threadId];
	const cwd = threadEntry?.thread.cwd ?? '';
	const adapterId = threadEntry?.thread.adapterId ?? defaultChatAdapterId();
	const adapter = getAdapter(adapterId);
	try {
		await adapter.attach?.(threadId, cwd || defaultCwd());
	} catch (e) {
		console.warn('attach (first prompt):', e);
	}
	const { streamId, iterable } = adapter.send({ threadId, text: prompt });
	useChatStore.getState().setStream(threadId, streamId);
	useChatStore.getState().setStatus(threadId, 'streaming');
	void (async () => {
		try {
			for await (const _ev of iterable) {
				// drain
			}
		} catch (e) {
			useChatStore
				.getState()
				.setStatus(threadId, 'error', e instanceof Error ? e.message : String(e));
		} finally {
			useChatStore.getState().setStream(threadId, null);
		}
	})();
	// Quiet unused-import lint
	void useChatActions;
}
