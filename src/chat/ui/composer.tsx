/**
 * Composer — AI Elements PromptInput (form + Enter/Shift+Enter handling
 * out of the box). Slash commands pass through to the adapter verbatim.
 * Esc cancels while streaming.
 *
 * v2 additions:
 *   - Visible Stop button (not just Esc) when streaming.
 *   - Inline error banner with Retry when the last `send` threw.
 */

import { useMemo, useRef, useState } from 'react';
import { AlertCircle, ImagePlus, Square, X } from 'lucide-react';
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
import {
	acpPrompt,
	acpSetEffort,
	acpSetMode,
	acpSetModel,
	type AcpContentBlock,
	type AcpSessionModeId,
} from '@/lib/tauri-cmd';
import { useChatActions, useThreadState } from '../hooks';
import { useChatStore } from '../store';
import { type ChatEffort } from '../adapter';
import { filterSlashCommands, useSlashCommands, type SlashCommand } from '../slash-commands';

/** ADR-011 phase 3: Model + Effort options exposed in the composer pills.
 *  Ids match what claude CLI accepts via `--model`. Mirror of the
 *  AcpAdapter.models list so the composer can render without depending
 *  on the active adapter (which can be the legacy CLI adapter). */
const MODEL_OPTIONS: Array<{ id: string; label: string }> = [
	{ id: 'claude-opus-4-7', label: 'Opus 4.7' },
	{ id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
	{ id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
];

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
	const { send, cancel, isStreaming, canSend, lastError } = useChatActions(threadId);
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
		// Replace the typed `/foo` prefix with `/cmd ` and keep the rest of
		// whatever the user typed after it.
		const trimmed = text.replace(/^\s*/, '');
		const rest = trimmed.replace(/^\/[^\s]*/, '').replace(/^\s*/, '');
		const next = `/${cmd.name}${rest ? ` ${rest}` : ' '}`;
		setText(next);
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
			// Image-bearing sends fire `acpPrompt` directly so the images reach
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
				await acpPrompt({ sessionId: threadId, prompt: blocks });
			} catch (e) {
				// Surface failures via the same lastError banner the legacy path
				// uses. The hooks layer doesn't own this state for ACP yet, so
				// we just log; Phase 10 unifies error handling.
				console.error('acpPrompt failed:', e);
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
	// TODO(phase-10): hydrate from `acpNewSession().modes.currentModeId`
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
			await acpSetMode(threadId, next);
		} catch (e) {
			setCurrentMode(previous);
			setModeError(e instanceof Error ? e.message : String(e));
		}
	}

	// ADR-011 phase 3: Model + Effort selection. Model is mirrored on
	// `ChatThread.model` so the pill stays in sync across composer
	// remounts. Effort doesn't have a persisted thread field yet, so it
	// lives purely in local state and resets on remount — the Rust side
	// keeps the authoritative value on `SessionOpts.effort`. Per-turn
	// switching is deferred per ADR; changes take effect on next spawn.
	const setThread = useChatStore((s) => s.setThread);
	const currentModel = state?.thread.model ?? null;
	const currentModelLabel =
		MODEL_OPTIONS.find((m) => m.id === currentModel)?.label ??
		currentModel?.replace(/^claude-/, '').replace(/-/g, ' ') ??
		'Auto';
	const [currentEffort, setCurrentEffort] = useState<ChatEffort>('off');

	async function handleModelChange(nextId: string) {
		if (!threadId) return;
		if (nextId === currentModel) return;
		const previous = currentModel;
		// Optimistic local mirror so the pill flips immediately.
		setThread(threadId, { model: nextId });
		try {
			await acpSetModel(threadId, nextId);
		} catch (e) {
			setThread(threadId, { model: previous });
			console.warn('acpSetModel:', e);
		}
	}

	async function handleEffortChange(next: ChatEffort) {
		if (!threadId) return;
		if (next === currentEffort) return;
		const previous = currentEffort;
		setCurrentEffort(next);
		try {
			await acpSetEffort(threadId, next);
		} catch (e) {
			setCurrentEffort(previous);
			console.warn('acpSetEffort:', e);
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
							<li key={cmd.path}>
								<button
									type="button"
									onMouseDown={(e) => {
										e.preventDefault();
										insertSlashCommand(cmd);
									}}
									className={cn(
										'flex w-full items-center gap-2 border-l-2 border-transparent px-2 py-1 text-left text-xs transition-colors hover:bg-[var(--rule-soft)]',
										idx === slashIdx &&
											'border-l-[var(--kola-amber)] bg-[var(--rule-soft)] text-foreground'
									)}
								>
									<span className="font-mono">/{cmd.name}</span>
									<span className="ml-auto font-mono text-[9px] uppercase tracking-wider text-[var(--chip-carve)]">
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
							{/* ADR-011 phase 3: Model picker — session-level. Stored on
							    SessionOpts.model and applied on next spawn. */}
							<Select
								value={currentModel ?? ''}
								onValueChange={(v) => void handleModelChange(v)}
								disabled={!threadId}
							>
								<SelectTrigger
									className="h-5 gap-1 rounded-sm border border-[var(--rule)] bg-transparent px-1.5 py-0 font-mono text-[10px] uppercase tracking-wider text-[var(--kola-amber-soft)] transition-colors hover:border-[var(--kola-amber)] hover:bg-[var(--rule-soft)] [&>svg]:size-3"
									aria-label="Model"
									title="Model — applied on next spawn (per-turn switching deferred)"
								>
									<SelectValue>{currentModelLabel}</SelectValue>
								</SelectTrigger>
								<SelectContent>
									{MODEL_OPTIONS.map((m) => (
										<SelectItem key={m.id} value={m.id} className="text-xs">
											{m.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
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
