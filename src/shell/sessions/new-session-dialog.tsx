import { useEffect, useRef, useState } from 'react';
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
import { Segmented } from '@/components/ui/segmented';
import { mintThreadId, useChatActions, useChatStore } from '@/chat';
import { createThread } from '@/chat';
import { defaultChatAdapterId } from '@/chat/default-adapter';
import { useEngineCatalog } from '@/chat/engines';
import { getAdapter, hasAdapter } from '@/chat/registry';
import { activeProjectCwd } from '@/lib/shell/active-project-cwd';
import { useShellStore } from '@/lib/shell/shell-store';
import { sessionEnsure } from '@/lib/tauri-cmd';
import { createTerminalSession } from '@/terminal/single-terminal';
import { buildClaudeWrappedCmd } from '@/terminal/claude-wrap';
import { usePaneStore } from '@/lib/panes/pane-store';

type Mode = 'chat' | 'terminal';

/**
 * Result handed back to a programmatic caller (the `host.openSessionDialog`
 * verb via `open-session-dialog.ts`). Direct callers of `<NewSessionDialog>`
 * — the /claude route, /sessions index, sessions sidebar mode — don't pass
 * `onComplete` and the dialog stays UI-only.
 */
export type NewSessionDialogResult =
	| { ok: true; kind: 'chat'; threadId: string }
	| { ok: true; kind: 'terminal'; paneId: string }
	| { ok: false; reason: 'cancelled' };

interface NewSessionDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	defaultProjects?: string[];
	/** Pre-filled prompt — used by /claude "New session" buttons that target a
	 *  specific agent or run a command body. Also threaded through by the
	 *  `host.openSessionDialog` verb (WP-27 / G-SESSION-DIALOG): the dialog is
	 *  the consent surface, the user can edit before Start. */
	presetPrompt?: string;
	/** Which mode to default to. Most callers want 'chat' now; the legacy
	 *  /sessions list still defaults to 'chat' too. */
	defaultMode?: Mode;
	/** Engine adapter id to pre-select. The dialog enumerates installed
	 *  engines via `useEngineCatalog()`; this just sets the initial highlight.
	 *  No-op when the id isn't in the catalog. */
	presetEngineId?: string;
	/** Project directory to pre-select (e.g. an absolute path that exists in
	 *  the `projects` list). No-op when the value isn't in the dropdown. */
	presetCwd?: string;
	/** Programmatic completion callback. Fired exactly once per open:
	 *    - after Start in Chat mode  → `{ ok: true,  kind: 'chat',     threadId }`
	 *    - after Start in Terminal mode → `{ ok: true,  kind: 'terminal', paneId   }`
	 *    - on Cancel / dismiss        → `{ ok: false, reason: 'cancelled' }`
	 *  Direct callers (sidebar new-chat button, /claude header) don't pass
	 *  this and the dialog stays UI-only as today. */
	onComplete?: (result: NewSessionDialogResult) => void;
}

export function NewSessionDialog({
	open,
	onOpenChange,
	defaultProjects = [],
	presetPrompt,
	defaultMode = 'chat',
	presetEngineId,
	presetCwd,
	onComplete,
}: NewSessionDialogProps) {
	// Programmatic-open completion contract: exactly one settle per open.
	// `completed` flips true when handleStartChat / handleOpenTerminal fire
	// onComplete; the Cancel branch (via onOpenChange) reads it to know
	// whether to fire 'cancelled' or stay quiet (Start already settled). This
	// is also the guard against React re-mounts double-firing.
	const completedRef = useRef(false);
	// Reset the guard every time the dialog opens. Without this, a programmatic
	// open after a previous run completes would never fire onComplete because
	// completedRef is still latched true.
	useEffect(() => {
		if (open) completedRef.current = false;
	}, [open]);
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
	// Chat engine selection. Seeded from `defaultChatAdapterId()` on each
	// dialog open so a user changing the default in /settings/agent is
	// honored without a reload. The catalog row chip lets the user
	// override per-thread without leaving the dialog.
	const [engineId, setEngineId] = useState<string>(defaultChatAdapterId());
	const engineCatalog = useEngineCatalog();

	useEffect(() => {
		if (open) {
			// Pre-fill the working dir with the active project's root_path when
			// it's set; otherwise fall back to the first configured file root.
			// User can override either via the project picker (rebinds to a
			// different project's root) or by editing the dir directly.
			//
			// `presetCwd` (programmatic open) takes priority — but ONLY when
			// the value is in the projects dropdown. A bogus cwd just falls
			// through to the regular default; we don't surface "no such
			// project" because the user can pick another from the dropdown.
			const root = activeProject?.root_path ?? null;
			const fallbackCwd = root ?? projects[0] ?? '';
			const cwd = presetCwd && projects.includes(presetCwd) ? presetCwd : fallbackCwd;
			setProject(cwd);
			setProjectId(activeProjectId);
			setPrompt(presetPrompt ?? '');
			setMode(defaultMode);
			// Engine pre-select: programmatic callers can pin an engine id;
			// falls back to the user's configured default. We don't validate
			// against `engineCatalog` here because the catalog renders the
			// chip as disabled when the engine isn't installed — the user
			// sees and can pick another. (Validation would just silently
			// drop the preset on a fresh install where catalogs hydrate
			// asynchronously.)
			setEngineId(presetEngineId ?? defaultChatAdapterId());
			setErr(null);
		}
	}, [
		open,
		projects,
		presetPrompt,
		defaultMode,
		presetEngineId,
		presetCwd,
		activeProject?.root_path,
		activeProjectId,
	]);

	async function handleStartChat() {
		if (!project) return;
		setBusy(true);
		setErr(null);
		try {
			const threadId = mintThreadId();
			await createThread({
				id: threadId,
				adapterId: engineId,
				cwd: project,
				claudeSessionId: null,
				model: null,
				title: prompt.trim().slice(0, 80) || null,
				projectId,
			});
			await sessionEnsure(threadId, project, {});
			// Settle the programmatic-open promise (if any) BEFORE closing the
			// dialog so the verb's caller sees the result without racing the
			// Radix close transition.
			completedRef.current = true;
			onComplete?.({ ok: true, kind: 'chat', threadId });
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
		// `addTab` returns void today — we use the focused pane id as the
		// "where the terminal landed" handle the verb returns. (The pane
		// store doesn't currently expose a "newly added tab id"; if it does
		// in the future we should swap this to that.)
		completedRef.current = true;
		onComplete?.({ ok: true, kind: 'terminal', paneId: focusedId });
		onOpenChange(false);
	}

	// One-shot cancel emitter: Radix fires onOpenChange(false) for the
	// Cancel button, ESC, and outside-click. We can't tell those apart from
	// a successful Start that also calls onOpenChange(false) — so we use
	// `completedRef` as the witness. Without it, Start would settle with
	// `ok:true` and then immediately settle again with `cancelled`.
	function handleOpenChange(next: boolean) {
		if (!next && !completedRef.current && onComplete) {
			completedRef.current = true;
			onComplete({ ok: false, reason: 'cancelled' });
		}
		onOpenChange(next);
	}

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
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
					<Segmented
						variant="card"
						ariaLabel="Session mode"
						value={mode}
						onValueChange={(id) => setMode(id as Mode)}
						items={[
							{
								id: 'chat',
								label: 'Chat',
								icon: <MessageSquare className="h-3.5 w-3.5" />,
								detail: 'streaming, in-app',
							},
							{
								id: 'terminal',
								label: 'Terminal',
								icon: <Terminal className="h-3.5 w-3.5" />,
								detail: 'PTY, claude TUI',
							},
						]}
					/>

					{mode === 'chat' && (
						<div className="space-y-1.5">
							<div className="flex items-baseline justify-between">
								<span className="text-xs font-medium text-muted-foreground">Engine</span>
								<button
									type="button"
									onClick={() => {
										// Treat as cancel: the user is leaving for settings, so
										// any programmatic caller awaiting a start sees a clean
										// 'cancelled' result rather than a hanging promise.
										handleOpenChange(false);
										navigate({ to: '/settings/agent' });
									}}
									className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
									title="Change default engine in settings"
								>
									set default →
								</button>
							</div>
							<div className="flex flex-wrap gap-1.5">
								{engineCatalog.map((eng) => {
									const active = eng.id === engineId;
									const clickable = eng.installed || active;
									const EngineIcon = hasAdapter(eng.id) ? getAdapter(eng.id).Icon : null;
									return (
										<button
											key={eng.id}
											type="button"
											disabled={!clickable}
											onClick={() => clickable && setEngineId(eng.id)}
											title={
												!eng.installed ? (eng.notInstalledHint ?? 'not installed') : eng.description
											}
											className={
												'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors ' +
												(active
													? 'border-primary bg-primary/10 text-foreground'
													: clickable
														? 'border-input bg-background hover:bg-accent'
														: 'cursor-not-allowed border-input bg-background opacity-50')
											}
										>
											{EngineIcon && <EngineIcon className="h-3.5 w-3.5" />}
											<span className="font-medium">{eng.label}</span>
											{!eng.installed && (
												<span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
													n/a
												</span>
											)}
										</button>
									);
								})}
							</div>
						</div>
					)}

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
					<Button type="button" variant="ghost" onClick={() => handleOpenChange(false)}>
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
		await adapter.attach?.(threadId, cwd || activeProjectCwd());
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
