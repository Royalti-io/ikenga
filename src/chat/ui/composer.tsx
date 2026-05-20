/**
 * Composer — AI Elements PromptInput (form + Enter/Shift+Enter handling
 * out of the box). Slash commands pass through to the adapter verbatim.
 * Esc cancels while streaming.
 *
 * v2 additions:
 *   - Visible Stop button (not just Esc) when streaming.
 *   - Inline error banner with Retry when the last `send` threw.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, ChevronLeft, ImagePlus, Square, X } from 'lucide-react';
import type { ChatStatus } from 'ai';
import { cn } from '@/components/ui/utils';
import {
	PromptInput,
	PromptInputBody,
	PromptInputSubmit,
	PromptInputTextarea,
	type PromptInputMessage,
} from '@/components/ai-elements/prompt-input';
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog';
import { useNavigate } from '@tanstack/react-router';
import {
	chatPrompt,
	chatSetEffort,
	chatSetMode,
	type AcpContentBlock,
	type AcpSessionModeId,
} from '@/lib/tauri-cmd';
import { useChatActions, useThreadState } from '../hooks';
import { usePendingPrompts } from '../pending-prompts';
import { type ChatEffort } from '../adapter';
import { modelLabelFor, useEngineCatalog } from '../engines';
import { EngineAuthPanel } from './engine-auth-panel';
import { createThread } from '../persist';
import { mintThreadId } from '../hooks';
import { createTerminalSession } from '@/terminal/single-terminal';
import { buildClaudeWrappedCmd } from '@/terminal/claude-wrap';
import { usePaneStore } from '@/lib/panes/pane-store';
import { open as openExternal } from '@tauri-apps/plugin-shell';
import { filterSlashCommands, useSlashCommands, type SlashCommand } from '../slash-commands';

const EFFORT_OPTIONS: ReadonlyArray<{ id: ChatEffort; label: string; lit: number }> = [
	{ id: 'off', label: 'Off', lit: 0 },
	{ id: 'low', label: 'Low', lit: 1 },
	{ id: 'medium', label: 'Med', lit: 3 },
	{ id: 'high', label: 'High', lit: 4 },
	{ id: 'max', label: 'Max', lit: 5 },
];

/**
 * Phase 7: in-memory image attachment state. `base64` is the raw payload
 * we ship to claude (no `data:` URI prefix). `previewUrl` is a data URL
 * built once for the thumbnail strip — keeping it separate from `base64`
 * means we don't re-concatenate the long string on every render.
 */
interface PendingImage {
	id: string;
	mimeType: string;
	base64: string;
	previewUrl: string;
}

/** MIME types claude accepts for input images. We refuse the rest at the
 *  paste/drop boundary so the user sees nothing rather than a confusing
 *  "image type not supported" error from the Anthropic API. */
const SUPPORTED_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/** Strip the `data:image/png;base64,` prefix from a FileReader.readAsDataURL
 *  result so we get the raw base64 payload claude wants on the wire. */
function stripDataUrlPrefix(dataUrl: string): string {
	const idx = dataUrl.indexOf(',');
	return idx === -1 ? dataUrl : dataUrl.slice(idx + 1);
}

async function fileToPendingImage(file: File): Promise<PendingImage | null> {
	if (!SUPPORTED_IMAGE_MIME_TYPES.has(file.type)) return null;
	const dataUrl: string = await new Promise((resolve, reject) => {
		const fr = new FileReader();
		fr.onload = () => resolve(fr.result as string);
		fr.onerror = () => reject(fr.error ?? new Error('FileReader failed'));
		fr.readAsDataURL(file);
	});
	return {
		id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		mimeType: file.type,
		base64: stripDataUrlPrefix(dataUrl),
		previewUrl: dataUrl,
	};
}

interface ComposerProps {
	threadId: string | null;
	className?: string;
	placeholder?: string;
}

/** Display labels for the four canonical ACP session modes. Keep in sync
 *  with `src-tauri/src/acp/mode.rs::available_modes`. */
const MODE_LABELS: Record<AcpSessionModeId, string> = {
	plan: 'Plan',
	default: 'Default',
	auto: 'Auto',
	bypassPermissions: 'Bypass',
};
const MODE_IDS: AcpSessionModeId[] = ['plan', 'default', 'auto', 'bypassPermissions'];

export function Composer({ threadId, className, placeholder }: ComposerProps) {
	const [text, setText] = useState('');
	const state = useThreadState(threadId);
	// Pin-routing fall-through: when `pin://routed` lands on this thread,
	// the shell-level listener (use-pin-routed-listener.ts) queues the
	// structured prompt here. Consume it on mount + threadId change so the
	// composer pre-fills and the user just hits Enter to send. We pull the
	// per-thread value directly so the effect re-runs when this thread's
	// entry appears, rather than on every other thread's enqueue churn.
	const pendingForThread = usePendingPrompts((s) => (threadId ? s.byThread[threadId] : undefined));
	const consumePendingPrompt = usePendingPrompts((s) => s.consume);
	useEffect(() => {
		if (!threadId || pendingForThread === undefined) return;
		// Only adopt the queued prompt when the user hasn't started typing
		// something else — clobbering an in-flight message would be rude.
		setText((cur) => (cur.length === 0 ? pendingForThread : cur));
		consumePendingPrompt(threadId);
	}, [threadId, pendingForThread, consumePendingPrompt]);
	// ADR-013 Phase 6: per-turn engine selection. `selectedEngineId` is
	// the composer-local override threaded into `useChatActions` so each
	// send routes through the picker's current engine. The thread's
	// persisted `engineId` (the engine the thread was created with)
	// stays pinned across swaps — only the per-turn route changes.
	// Initialise to the thread's adapter so behaviour matches the prior
	// implementation until the user changes the picker.
	const initialEngineId = (() => {
		const id = state?.thread.adapterId ?? null;
		if (id === 'acp' || id === 'cli') return 'claude-code';
		return id;
	})();
	const [selectedEngineId, setSelectedEngineId] = useState<string | null>(initialEngineId);
	// Selected model — composer-local, transient. NOT persisted via
	// `chatSetModel` per ADR-013 Phase 6 ("treat the picker as
	// transient"). Resets to the thread's persisted model when the
	// composer remounts (route change, tab swap).
	const [selectedModelId, setSelectedModelId] = useState<string | null>(
		state?.thread.model ?? null
	);
	// ADR-013 Phase 6 warn affordance — dismissible per session (component
	// state, no persistence). Shows only when `selectedEngineId !==
	// thread.engineId` so swapping back to the thread's original engine
	// makes the warn go away.
	const [warnDismissed, setWarnDismissed] = useState(false);
	// When the thread changes (route nav), reset the picker selection to
	// the thread's persisted defaults. Without this the composer would
	// hold onto the previous thread's engine/model selection.
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentionally keyed on threadId only — re-reading `state` on every thread switch is the whole point of the reset, but listing `state` would re-fire on every render.
	useEffect(() => {
		const id = state?.thread.adapterId ?? null;
		const normalized = id === 'acp' || id === 'cli' ? 'claude-code' : id;
		setSelectedEngineId(normalized);
		setSelectedModelId(state?.thread.model ?? null);
		// Reset the warn dismiss when we change threads so each new thread
		// surfaces the warn once if the user diverges.
		setWarnDismissed(false);
	}, [threadId]);

	const { send, cancel, isStreaming, canSend, lastError } = useChatActions(
		threadId,
		selectedEngineId ?? undefined
	);
	const lastSentRef = useRef<string | null>(null);
	/** Hidden file input ref. Triggered by the Attach button so users have a
	 *  discoverable affordance alongside paste + drag/drop. */
	const fileInputRef = useRef<HTMLInputElement>(null);
	const isSlash = text.trimStart().startsWith('/');

	const slashCommands = useSlashCommands(state?.thread.cwd);
	// Match the first whitespace-delimited token (the slash command name).
	const slashQuery = useMemo(() => {
		if (!isSlash) return null;
		const t = text.trimStart();
		const m = t.match(/^\/([^\s]*)/);
		return m ? m[1] : '';
	}, [isSlash, text]);
	const slashMatches = useMemo(
		() => (slashQuery !== null ? filterSlashCommands(slashCommands, slashQuery) : []),
		[slashCommands, slashQuery]
	);
	const [slashIdx, setSlashIdx] = useState(0);
	// Clamp on list change.
	if (slashIdx >= slashMatches.length && slashMatches.length > 0) {
		setSlashIdx(0);
	}

	function insertSlashCommand(cmd: SlashCommand) {
		// Built-in commands dispatch on their action instead of inserting
		// `/name` into the textarea. Stream-json mode can't execute them
		// on the engine side, so we either summon the equivalent UI
		// affordance or hand off to a real interactive `claude` terminal.
		if (cmd.source === 'builtin' && cmd.action) {
			void runBuiltinSlash(cmd);
			// Clear the typed `/foo` so the textarea returns to ready state.
			setText('');
			return;
		}
		// User/project .md commands: keep the legacy "insert into textarea
		// and send as a literal slash message" behavior. The engine sees
		// the `/name` as a user message.
		const trimmed = text.replace(/^\s*/, '');
		const rest = trimmed.replace(/^\/[^\s]*/, '').replace(/^\s*/, '');
		const next = `/${cmd.name}${rest ? ` ${rest}` : ' '}`;
		setText(next);
	}

	async function runBuiltinSlash(cmd: SlashCommand) {
		if (!cmd.action) return;
		const action = cmd.action;
		switch (action.type) {
			case 'navigate':
				void navigate({ to: action.to });
				return;
			case 'new-thread': {
				if (!state?.thread.cwd) return;
				const newId = mintThreadId();
				await createThread({
					id: newId,
					adapterId: state.thread.adapterId,
					cwd: state.thread.cwd,
					claudeSessionId: null,
					model: state.thread.model,
					title: null,
					projectId: state.thread.projectId ?? null,
				});
				void navigate({ to: '/sessions/$sessionId', params: { sessionId: newId } });
				return;
			}
			case 'open-engine-picker':
				setEngineMenuOpen(true);
				return;
			case 'open-effort-picker':
			case 'open-mode-picker':
				// Both pills are sibling Select components; we don't currently
				// expose imperative-open APIs on them. Cheapest surface: a
				// no-op hint until we wire `open` state out of the Select
				// primitives. For now the picker is one click away.
				console.info(`[slash:${cmd.name}] open the pill next to the model picker`);
				return;
			case 'open-attach-file':
				fileInputRef.current?.click();
				return;
			case 'terminal-handoff': {
				if (!state?.thread.cwd) return;
				const sessionId = createTerminalSession({
					cwd: state.thread.cwd,
					cmd: buildClaudeWrappedCmd({ prompt: action.command }),
					title: `claude · ${action.command}`,
				});
				const focusedId = usePaneStore.getState().focusedId;
				usePaneStore.getState().addTab(focusedId, { kind: 'terminal', sessionId });
				return;
			}
			case 'open-external':
				void openExternal(action.url);
				return;
			case 'noop':
				console.info(`[slash:${cmd.name}] ${action.hint}`);
				return;
		}
	}

	// Phase 7 image attachment state. Phase 11 unconditionally accepts images;
	// legacy CLI sends still go through the standard `send` path with no image
	// strip attached.
	const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);

	async function appendImagesFromFiles(files: FileList | File[] | null | undefined) {
		if (!files) return;
		const list = Array.from(files);
		const additions: PendingImage[] = [];
		for (const f of list) {
			const img = await fileToPendingImage(f);
			if (img) additions.push(img);
		}
		if (additions.length > 0) {
			setPendingImages((prev) => [...prev, ...additions]);
		}
	}

	async function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
		// System-clipboard images (screenshots, "copy image" from a browser, etc.)
		// arrive via `items` with `kind === 'file'` on every major platform.
		// `e.clipboardData.files` is empty for those — it's only populated when
		// the user pastes a file copied from the OS file manager. Walk items so
		// both paths work.
		const items = e.clipboardData?.items;
		if (!items || items.length === 0) return;
		const files: File[] = [];
		for (const item of items) {
			if (item.kind === 'file') {
				const f = item.getAsFile();
				if (f && SUPPORTED_IMAGE_MIME_TYPES.has(f.type)) files.push(f);
			}
		}
		if (files.length === 0) return; // pure-text paste — let the textarea handle it
		e.preventDefault();
		await appendImagesFromFiles(files);
	}

	async function handleDrop(e: React.DragEvent<HTMLDivElement>) {
		const files = e.dataTransfer?.files;
		if (!files || files.length === 0) return;
		const hasImage = Array.from(files).some((f) => SUPPORTED_IMAGE_MIME_TYPES.has(f.type));
		if (!hasImage) return;
		e.preventDefault();
		await appendImagesFromFiles(files);
	}

	function handleDragOver(e: React.DragEvent<HTMLDivElement>) {
		// Required to allow drop.
		e.preventDefault();
	}

	function removePendingImage(id: string) {
		setPendingImages((prev) => prev.filter((p) => p.id !== id));
	}

	async function handleSubmit(message: PromptInputMessage) {
		const value = message.text;
		const hasImages = pendingImages.length > 0;
		if (!value.trim() && !hasImages) return;
		setText('');
		lastSentRef.current = value;

		if (hasImages && threadId) {
			// Image-bearing sends fire `chatPrompt` directly so the images reach
			// claude's stream-json envelope. Text-only sends still route through
			// the adapter so the legacy CLI path stays functional for opt-out
			// users.
			const images = pendingImages;
			setPendingImages([]);
			const blocks: AcpContentBlock[] = [];
			if (value.trim().length > 0) {
				blocks.push({ type: 'text', text: value });
			}
			for (const img of images) {
				blocks.push({ type: 'image', data: img.base64, mimeType: img.mimeType });
			}
			try {
				// ADR-013 §4: per-turn engineId override for image sends too.
				// `selectedEngineId` is the picker's current pick; `ChatEngineId`
				// in tauri-cmd is the union of canonical engine ids, so cast
				// once at the boundary.
				await chatPrompt(
					{ sessionId: threadId, prompt: blocks },
					(selectedEngineId ?? undefined) as
						| 'claude-code'
						| 'gemini'
						| 'codex'
						| 'cursor-agent'
						| undefined
				);
			} catch (e) {
				// Surface failures via the same lastError banner the legacy path
				// uses. The hooks layer doesn't own this state for ACP yet, so
				// we just log; Phase 10 unifies error handling.
				console.error('chatPrompt failed:', e);
			}
			return;
		}

		await send(value);
	}

	function handleRetry() {
		const v = lastSentRef.current;
		if (!v) return;
		void send(v);
	}

	function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
		if (e.key === 'Escape' && isStreaming) {
			e.preventDefault();
			void cancel();
			return;
		}
		if (slashMatches.length > 0) {
			if (e.key === 'ArrowDown') {
				e.preventDefault();
				setSlashIdx((i) => Math.min(i + 1, slashMatches.length - 1));
				return;
			}
			if (e.key === 'ArrowUp') {
				e.preventDefault();
				setSlashIdx((i) => Math.max(i - 1, 0));
				return;
			}
			if (e.key === 'Tab') {
				e.preventDefault();
				const pick = slashMatches[slashIdx];
				if (pick) insertSlashCommand(pick);
				return;
			}
		}
	}

	const disabled = !threadId || (!canSend && !isStreaming);
	const adapterLabel = state?.thread.adapterId === 'cli' ? 'Claude CLI' : state?.thread.adapterId;
	const status: ChatStatus = isStreaming ? 'streaming' : 'ready';

	// Phase 5: ACP session-mode picker state. Local-only — the Rust server
	// is the source of truth (`AcpServer.handle_set_mode`), but we mirror
	// it here so the dropdown reflects what we last set. Default `default`
	// matches the spawn-time fallback in `SessionOpts::default`.
	// TODO(phase-10): hydrate from `chatNewSession().modes.currentModeId`
	// when the composer takes over the new_session call itself.
	const [currentMode, setCurrentMode] = useState<AcpSessionModeId>('default');
	const [modeError, setModeError] = useState<string | null>(null);

	async function handleModeChange(next: AcpSessionModeId) {
		if (!threadId) return;
		if (next === currentMode) return;
		const previous = currentMode;
		// Optimistic update — flip back if the Rust side rejects.
		setCurrentMode(next);
		setModeError(null);
		try {
			await chatSetMode(threadId, next);
		} catch (e) {
			setCurrentMode(previous);
			setModeError(e instanceof Error ? e.message : String(e));
		}
	}

	// ADR-013 Phase 6: model + engine are per-turn. We track them as
	// composer-local state (`selectedEngineId`, `selectedModelId` above)
	// rather than persisting via `chatSetModel`. Effort is still
	// session-level — the Rust side keeps the authoritative value on
	// `SessionOpts.effort` and applies it on next spawn.
	const [currentEffort, setCurrentEffort] = useState<ChatEffort>('off');
	// ADR-011 phase 4 / ADR-013 §3: open/close state for the Engine→Model
	// popover. Tracking it lets us auto-close when the user picks a model.
	const [engineMenuOpen, setEngineMenuOpen] = useState(false);
	// ADR-013 §3 two-level picker — which panel is currently visible inside
	// the single Popover. `engines` shows the engine list; `models` shows
	// `panelEngineId`'s model list with a back affordance.
	const [pickerPanel, setPickerPanel] = useState<'engines' | 'models'>('engines');
	const [panelEngineId, setPanelEngineId] = useState<string | null>(null);
	// ADR-013 §5 lazy-auth dialog — set to the engine id whose auth surface
	// the user opened by clicking a not-installed picker row. Null = closed.
	const [authDialogEngineId, setAuthDialogEngineId] = useState<string | null>(null);
	const navigate = useNavigate();
	// Live engine catalog — registered ∩ detected. The popover renders
	// every catalog entry; rows whose `installed === false` are non-
	// clickable with a tooltip explaining why.
	const catalog = useEngineCatalog();
	// ADR-013 §4: `thread.engineId` is the engine the thread was created
	// with (persisted in `chat_sessions.engine_id`). The warn affordance
	// fires when `selectedEngineId` diverges from this. Persisted `'acp'`
	// / `'cli'` alias to `'claude-code'` per the registry; treat them as
	// identical here. Falls back to `adapterId` for any thread whose
	// `engineId` column couldn't be read (defensive; the migration covers
	// every real row).
	const threadEngineId = (() => {
		const id = state?.thread.engineId ?? state?.thread.adapterId ?? null;
		if (id === 'acp' || id === 'cli') return 'claude-code';
		return id;
	})();
	const selectedEngine = useMemo(
		() => catalog.find((e) => e.id === selectedEngineId) ?? null,
		[catalog, selectedEngineId]
	);
	const panelEngine = useMemo(
		() => catalog.find((e) => e.id === panelEngineId) ?? null,
		[catalog, panelEngineId]
	);
	const currentModelLabel = modelLabelFor(selectedModelId);

	// When the popover opens, reset the panel to the engine list so each
	// open starts from the top level. Cheaper than tracking "which engine
	// the user was last looking at" across opens.
	useEffect(() => {
		if (!engineMenuOpen) return;
		setPickerPanel('engines');
		setPanelEngineId(null);
	}, [engineMenuOpen]);

	// ADR-013 §5 — auto-close the lazy-auth dialog once its engine flips to
	// `installed` in the live catalog. The EngineAuthPanel's onAuthComplete
	// invalidates `detect-agents` / `chat-engines-list` after the auth pane
	// exits; when the refetched catalog reports the engine installed, this
	// effect dismisses the now-stale "Set up X" UI. Failed auth leaves the
	// dialog open so the user can retry without re-clicking the picker row.
	useEffect(() => {
		if (!authDialogEngineId) return;
		const engine = catalog.find((e) => e.id === authDialogEngineId);
		if (engine?.installed) setAuthDialogEngineId(null);
	}, [catalog, authDialogEngineId]);

	function handleInstallEnginePkg() {
		setEngineMenuOpen(false);
		// Source of truth for installed engines is `agent_detect`, not the
		// pkg registry — /settings/agent exposes the picker UI + auth-status
		// banner backed by the same detection scan the onboarding wizard
		// uses. ADR-010 (engines-as-pkgs) is the long-term shape; until any
		// engine pkg ships, /settings/agent is the user-facing install hop.
		void navigate({ to: '/settings/agent' });
	}

	function handleEngineRowClick(engineId: string, installed: boolean) {
		if (!installed) {
			// ADR-013 §5 lazy-auth path: clicking a not-installed engine row
			// opens the shared auth sheet for that engine in place rather than
			// navigating away. The footer "install engine pkg" link still hops
			// to /settings/agent for the general browse flow.
			setEngineMenuOpen(false);
			setAuthDialogEngineId(engineId);
			return;
		}
		// Drill into this engine's model list.
		setPanelEngineId(engineId);
		setPickerPanel('models');
	}

	function handleModelPick(engineId: string, modelId: string | null) {
		setSelectedEngineId(engineId);
		setSelectedModelId(modelId);
		// If the user swaps away from the thread's pinned engine, surface
		// the warn affordance again (reset the dismiss). Swapping back to
		// the pinned engine clears the warn implicitly.
		if (engineId !== threadEngineId) {
			setWarnDismissed(false);
		}
		setEngineMenuOpen(false);
	}

	async function handleEffortChange(next: ChatEffort) {
		if (!threadId) return;
		if (next === currentEffort) return;
		const previous = currentEffort;
		setCurrentEffort(next);
		try {
			await chatSetEffort(threadId, next);
		} catch (e) {
			setCurrentEffort(previous);
			console.warn('chatSetEffort:', e);
		}
	}

	// ADR-011 phase 1: anvil composer — heat-dot intensity tracks composer
	// state. Cold = empty, warm = user typing, hot = streaming. The dot is
	// rendered next to the submit button below.
	const heatIntensity: 'cold' | 'warm' | 'hot' = isStreaming
		? 'hot'
		: text.trim().length > 0 || pendingImages.length > 0
			? 'warm'
			: 'cold';

	return (
		<div
			className={cn('border-t-2 border-[var(--rule)] bg-[var(--bg-raised)] px-4 py-3', className)}
			onDrop={handleDrop}
			onDragOver={handleDragOver}
		>
			{/* ADR-013 §5 lazy-auth dialog — opened from a not-installed engine
			    picker row. Reuses the same EngineAuthPanel as the onboarding
			    wizard step. A centered modal fits this one-shot auth task better
			    than a side sheet (and avoids the sheet's right-edge clipping). */}
			<Dialog
				open={authDialogEngineId !== null}
				onOpenChange={(open) => {
					if (!open) setAuthDialogEngineId(null);
				}}
			>
				<DialogContent>
					{authDialogEngineId && (
						<>
							<DialogHeader>
								<DialogTitle>
									Set up{' '}
									{catalog.find((e) => e.id === authDialogEngineId)?.label ?? authDialogEngineId}
								</DialogTitle>
								<DialogDescription>
									Add an API key or run the engine's auth command. We'll re-check once it's done.
								</DialogDescription>
							</DialogHeader>
							<EngineAuthPanel
								engineId={authDialogEngineId}
								engineLabel={catalog.find((e) => e.id === authDialogEngineId)?.label}
							/>
						</>
					)}
				</DialogContent>
			</Dialog>
			{lastError && !isStreaming && (
				<div className="mb-2 flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">
					<AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
					<div className="flex-1">
						<span className="font-medium">Send failed.</span>{' '}
						<span className="opacity-80">{lastError}</span>
					</div>
					{lastSentRef.current && (
						<button
							type="button"
							onClick={handleRetry}
							className="shrink-0 rounded border border-destructive/40 px-2 py-0.5 text-[11px] font-medium hover:bg-destructive/15"
						>
							Retry
						</button>
					)}
				</div>
			)}
			{isSlash && slashMatches.length > 0 && (
				<div className="mb-2 overflow-hidden rounded-sm border border-[var(--rule)] bg-background text-popover-foreground">
					<div className="border-b border-[var(--rule)] px-2 py-1 font-mono text-[9px] uppercase tracking-[0.22em] text-[var(--chip-carve)]">
						slash commands · ↑↓ choose · tab insert
					</div>
					<ul>
						{slashMatches.map((cmd, idx) => (
							<li key={`${cmd.source}:${cmd.name}`}>
								<button
									type="button"
									onMouseDown={(e) => {
										e.preventDefault();
										insertSlashCommand(cmd);
									}}
									className={cn(
										'flex w-full items-start gap-2 border-l-2 border-transparent px-2 py-1 text-left text-xs transition-colors hover:bg-[var(--rule-soft)]',
										idx === slashIdx &&
											'border-l-[var(--kola-amber)] bg-[var(--rule-soft)] text-foreground'
									)}
								>
									<span className="font-mono">/{cmd.name}</span>
									{cmd.description && (
										<span className="flex-1 truncate text-[11px] text-muted-foreground">
											{cmd.description}
										</span>
									)}
									<span className="ml-auto shrink-0 font-mono text-[9px] uppercase tracking-wider text-[var(--chip-carve)]">
										{cmd.source}
									</span>
								</button>
							</li>
						))}
					</ul>
				</div>
			)}
			{isSlash && slashMatches.length === 0 && slashQuery && (
				<div className="mb-2 flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-[var(--chip-carve)]">
					<span className="text-[var(--kola-amber)]">◾</span>
					<span>
						no <span className="normal-case tracking-normal">/{slashQuery}</span> defined — sent to
						claude as-is
					</span>
				</div>
			)}
			{pendingImages.length > 0 && (
				// Phase 7: thumbnail strip for pasted/dropped images. Each thumb has
				// an inline × to remove it pre-send.
				<div className="mb-2 flex flex-wrap gap-2 border-b border-[var(--rule)] pb-2">
					{pendingImages.map((img) => (
						<div
							key={img.id}
							className="group/thumb relative h-16 w-16 overflow-hidden rounded-sm border border-[var(--rule)] transition-colors hover:border-[var(--kola-amber)]"
						>
							<img src={img.previewUrl} alt="attachment" className="h-full w-full object-cover" />
							<button
								type="button"
								onClick={() => removePendingImage(img.id)}
								className="absolute right-0 top-0 flex h-4 w-4 items-center justify-center bg-background/80 text-[var(--chip-carve)] transition-colors hover:bg-background hover:text-[var(--oxblood)]"
								aria-label="Remove image"
							>
								<X className="h-3 w-3" />
							</button>
						</div>
					))}
				</div>
			)}
			<PromptInput onSubmit={handleSubmit} className="rounded-md border border-input">
				<PromptInputBody>
					<PromptInputTextarea
						value={text}
						onChange={(e) => setText(e.target.value)}
						onKeyDown={onKeyDown}
						onPaste={handlePaste}
						placeholder={placeholder ?? 'Send a message — Enter to submit, Shift+Enter for newline'}
						disabled={disabled && !isStreaming}
					/>
					<div className="flex items-center justify-between gap-2 px-2 py-1.5">
						<div className="flex items-center gap-2 text-[10px] text-muted-foreground">
							{/* Phase 7 attach button: opens a native file picker for images.
                  Paste + drag/drop still work (handlePaste / handleDrop above);
                  this gives the affordance a discoverable home. */}
							<input
								ref={fileInputRef}
								type="file"
								accept="image/*"
								multiple
								hidden
								onChange={(e) => {
									void appendImagesFromFiles(e.target.files);
									// Reset so picking the same file twice re-fires onChange.
									e.target.value = '';
								}}
							/>
							<button
								type="button"
								onClick={() => fileInputRef.current?.click()}
								className="inline-flex h-5 items-center gap-1 rounded-sm border border-[var(--rule)] bg-transparent px-1.5 font-mono text-[10px] uppercase tracking-wider text-foreground transition-colors hover:border-[var(--kola-amber)] hover:bg-[var(--rule-soft)]"
								aria-label="Attach image"
								title="Attach image (or paste / drag-drop)"
							>
								<ImagePlus className="h-3 w-3" />
								<span className="hidden sm:inline">attach</span>
							</button>
							<span className="text-[var(--chip-carve)]">{adapterLabel}</span>
							{/* ADR-013 §3 two-level Engine → Model popover. Top panel
							    shows installed-first engines; clicking an installed engine
							    drills into its model list. Engine + model are PER-TURN —
							    each send routes through `selectedEngineId`. The thread's
							    persisted `engineId` (the engine at creation) stays
							    pinned; flipping back to it resumes the original engine's
							    native session id. Footer routes to the pkg manager. */}
							<Popover open={engineMenuOpen} onOpenChange={setEngineMenuOpen}>
								<PopoverTrigger
									type="button"
									disabled={!threadId}
									className="inline-flex h-5 items-center gap-1 rounded-sm border border-[var(--rule)] bg-transparent px-1.5 font-mono text-[10px] uppercase tracking-wider text-[var(--kola-amber-soft)] transition-colors hover:border-[var(--kola-amber)] hover:bg-[var(--rule-soft)] disabled:cursor-not-allowed disabled:opacity-60"
									aria-label="Engine and model"
									title="Engine → Model — applied per turn"
								>
									{selectedEngine ? (
										<>
											<span className="text-[var(--chip-carve)]">{selectedEngine.label}</span>
											<span className="text-[var(--chip-carve)]">·</span>
											<span>{currentModelLabel}</span>
										</>
									) : (
										<span>{currentModelLabel}</span>
									)}
								</PopoverTrigger>
								<PopoverContent
									align="start"
									className="w-[360px] border border-[var(--rule)] bg-background p-0 font-sans"
								>
									{/* Header — label + (in model panel) back affordance. */}
									<div className="flex items-center gap-2 border-b border-[var(--rule)] px-3 py-1.5 font-mono text-[9px] uppercase tracking-[0.22em] text-[var(--chip-carve)]">
										{pickerPanel === 'models' && panelEngine ? (
											<>
												<button
													type="button"
													onClick={() => {
														setPickerPanel('engines');
														setPanelEngineId(null);
													}}
													className="inline-flex items-center gap-1 text-[var(--chip-carve)] transition-colors hover:text-[var(--kola-amber)]"
													aria-label="Back to engines"
													title="Back to engines"
												>
													<ChevronLeft className="h-3 w-3" />
													<span>engines</span>
												</button>
												<span className="text-[var(--chip-carve)]">·</span>
												<span className="text-foreground">{panelEngine.label}</span>
											</>
										) : (
											<>
												<span className="text-[var(--kola-amber)]">◾</span>
												<span className="text-foreground">Engine</span>
											</>
										)}
									</div>

									{pickerPanel === 'engines' ? (
										<ul className="max-h-[280px] overflow-auto py-1">
											{catalog.map((eng) => {
												const isSelected = eng.id === selectedEngineId;
												const isInstalled = eng.installed;
												const hint = !isInstalled
													? (eng.notInstalledHint ?? 'not installed')
													: undefined;
												return (
													<li key={eng.id}>
														<button
															type="button"
															onClick={() => handleEngineRowClick(eng.id, isInstalled)}
															title={hint}
															className={cn(
																'flex w-full items-center gap-2 border-l-2 border-transparent px-3 py-1.5 text-left text-xs transition-colors hover:bg-[var(--rule-soft)]',
																!isInstalled && 'opacity-70',
																isSelected &&
																	'border-l-[var(--kola-amber)] bg-[var(--rule-soft)] text-foreground'
															)}
														>
															<span className="font-mono">{eng.label}</span>
															{isSelected && (
																<span className="font-mono text-[9px] uppercase tracking-[0.22em] text-[var(--kola-amber)]">
																	active
																</span>
															)}
															<span className="ml-auto font-mono text-[9px] uppercase tracking-wider text-[var(--chip-carve)]">
																{isInstalled ? 'installed' : (hint ?? 'not installed')}
															</span>
														</button>
													</li>
												);
											})}
										</ul>
									) : panelEngine ? (
										<ul className="max-h-[280px] overflow-auto py-1">
											{panelEngine.models.length === 0 ? (
												// Engines whose model picker isn't pinned yet (e.g.
												// Codex pre-Phase 3, cursor-agent stub) get a single
												// "Use this engine" row that pins the engine without
												// a specific model id.
												<li>
													<button
														type="button"
														onClick={() => handleModelPick(panelEngine.id, null)}
														className="flex w-full items-center gap-2 border-l-2 border-transparent px-3 py-1.5 text-left text-xs transition-colors hover:bg-[var(--rule-soft)]"
													>
														<span className="font-mono">Use {panelEngine.label}</span>
														<span className="ml-auto font-mono text-[9px] uppercase tracking-wider text-[var(--chip-carve)]">
															default model
														</span>
													</button>
												</li>
											) : (
												panelEngine.models.map((m) => {
													const isSelected =
														panelEngine.id === selectedEngineId && m.id === selectedModelId;
													return (
														<li key={m.id}>
															<button
																type="button"
																onClick={() => handleModelPick(panelEngine.id, m.id)}
																className={cn(
																	'flex w-full items-center gap-2 border-l-2 border-transparent px-3 py-1.5 text-left text-xs transition-colors hover:bg-[var(--rule-soft)]',
																	isSelected &&
																		'border-l-[var(--kola-amber)] bg-[var(--rule-soft)] text-foreground'
																)}
															>
																<span className="font-mono">{m.label}</span>
																{isSelected && (
																	<span className="font-mono text-[9px] uppercase tracking-[0.22em] text-[var(--kola-amber)]">
																		✓
																	</span>
																)}
																<span className="ml-auto font-mono text-[9px] uppercase tracking-wider text-[var(--chip-carve)]">
																	{m.id}
																</span>
															</button>
														</li>
													);
												})
											)}
										</ul>
									) : null}

									{/* ADR-013 §4 warn affordance — only when the picker's
									    engine diverges from the thread's persisted engine.
									    Component-local `warnDismissed` state, no persistence;
									    resets when the user navigates to a different thread or
									    flips back to the pinned engine. */}
									{threadEngineId &&
										selectedEngineId &&
										selectedEngineId !== threadEngineId &&
										!warnDismissed && (
											<div className="flex items-start gap-2 border-t border-[var(--rule)] bg-[var(--rule-soft)] px-3 py-2 text-[11px] text-[var(--chip-carve)]">
												<span className="text-[var(--kola-amber)]">◾</span>
												<span className="flex-1 leading-snug">
													Switching engines starts a fresh context — previous turns won't be visible
													to {selectedEngine?.label ?? selectedEngineId}.
												</span>
												<button
													type="button"
													onClick={() => setWarnDismissed(true)}
													className="shrink-0 text-[var(--chip-carve)] transition-colors hover:text-[var(--kola-amber)]"
													aria-label="Dismiss warning"
												>
													<X className="h-3 w-3" />
												</button>
											</div>
										)}

									<div className="border-t border-[var(--rule)] bg-[var(--rule-soft)] px-2 py-1.5">
										<button
											type="button"
											onClick={handleInstallEnginePkg}
											className="flex w-full items-center gap-1 font-mono text-[10px] uppercase tracking-wider text-[var(--chip-carve)] transition-colors hover:text-[var(--kola-amber)]"
											title="Browse engine pkgs in the package manager"
										>
											<span className="text-[var(--kola-amber)]">+</span>
											<span>install engine pkg</span>
										</button>
									</div>
								</PopoverContent>
							</Popover>
							{/* ADR-011 phase 3: Effort picker — session-level. Maps to
							    --thinking-budget-tokens at spawn. */}
							<Select
								value={currentEffort}
								onValueChange={(v) => void handleEffortChange(v as ChatEffort)}
								disabled={!threadId}
							>
								<SelectTrigger
									className="h-5 gap-1.5 rounded-sm border border-[var(--rule)] bg-transparent px-1.5 py-0 font-mono text-[10px] uppercase tracking-wider text-[var(--ember-soft)] transition-colors hover:border-[var(--ember)] hover:bg-[var(--rule-soft)] [&>svg]:size-3"
									aria-label="Effort"
									title="Extended-thinking effort — applied on next spawn"
								>
									<SelectValue asChild>
										<span className="inline-flex items-center gap-1.5">
											<span>
												{EFFORT_OPTIONS.find((o) => o.id === currentEffort)?.label ?? 'Off'}
											</span>
											<span aria-hidden className="inline-flex items-center gap-[2px]">
												{[0, 1, 2, 3, 4].map((i) => (
													<span
														key={i}
														className={cn(
															'inline-block h-2 w-[2px]',
															i < (EFFORT_OPTIONS.find((o) => o.id === currentEffort)?.lit ?? 0)
																? 'bg-[var(--ember)]'
																: 'bg-[var(--rule)]'
														)}
													/>
												))}
											</span>
										</span>
									</SelectValue>
								</SelectTrigger>
								<SelectContent>
									{EFFORT_OPTIONS.map((o) => (
										<SelectItem key={o.id} value={o.id} className="text-xs">
											{o.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							{/* Phase 5 mode picker: badge-styled trigger + select dropdown. */}
							<Select
								value={currentMode}
								onValueChange={(v) => void handleModeChange(v as AcpSessionModeId)}
								disabled={!threadId}
							>
								<SelectTrigger
									className="h-5 gap-1 rounded-sm border border-[var(--rule)] bg-transparent px-1.5 py-0 font-mono text-[10px] uppercase tracking-wider text-foreground transition-colors hover:border-[var(--kola-amber)] hover:bg-[var(--rule-soft)] [&>svg]:size-3"
									aria-label="Session mode"
								>
									<SelectValue>{MODE_LABELS[currentMode]}</SelectValue>
								</SelectTrigger>
								<SelectContent>
									{MODE_IDS.map((m) => (
										<SelectItem key={m} value={m} className="text-xs">
											{MODE_LABELS[m]}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							{modeError && (
								<span className="text-destructive" title={modeError}>
									· mode change failed
								</span>
							)}
							{isStreaming && <span>· Esc or Stop to cancel</span>}
						</div>
						<div className="flex items-center gap-2">
							{/* ADR-011 phase 1: heat-dot — ember intensity tracks composer state.
							    cold = idle, warm = user typing / image attached, hot = streaming. */}
							<span
								aria-hidden
								className={cn(
									'inline-block h-1.5 w-1.5 rounded-full transition-all',
									heatIntensity === 'cold' && 'bg-[var(--rule)]',
									heatIntensity === 'warm' &&
										'bg-[var(--ember-soft)] shadow-[0_0_4px_var(--ember-soft)]',
									heatIntensity === 'hot' &&
										'animate-pulse bg-[var(--ember)] shadow-[0_0_6px_var(--ember),0_0_12px_color-mix(in_oklab,var(--ember)_40%,transparent)]'
								)}
								title={`composer heat: ${heatIntensity}`}
							/>
							{isStreaming && (
								<button
									type="button"
									onClick={() => void cancel()}
									className="inline-flex items-center gap-1 rounded-md border border-input bg-background px-2.5 py-1 text-xs hover:bg-accent"
									title="Stop generation (Esc)"
								>
									<Square className="h-3 w-3 fill-current" />
									Stop
								</button>
							)}
							<PromptInputSubmit
								status={status}
								onStop={() => void cancel()}
								disabled={
									!isStreaming &&
									(disabled ||
										(text.trim().length === 0 &&
											// Image-only sends are valid — the Rust-side extractor
											// adds a default text anchor when needed.
											pendingImages.length === 0))
								}
							/>
						</div>
					</div>
				</PromptInputBody>
			</PromptInput>
		</div>
	);
}
