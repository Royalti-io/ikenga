/**
 * Thread — store-backed event list. Uses AI Elements <Conversation> for
 * smart sticky-scroll, <Message> for user/assistant chat exchanges, and
 * compact <Row>s for system/diagnostic events (session_init, done, hooks,
 * rate_limit, etc). Tool calls render through <ToolCallCard>.
 */

import { useEffect, useMemo, useState } from 'react';
import {
	AlertCircle,
	Bot,
	Brain,
	CheckCircle2,
	CircleAlert,
	GitBranch,
	Loader2,
} from 'lucide-react';
import type { ChatEvent } from '@/lib/tauri-cmd';
import { cn } from '@/components/ui/utils';
import {
	Conversation,
	ConversationContent,
	ConversationEmptyState,
	ConversationScrollButton,
} from '@/components/ai-elements/conversation';
import { buildRenderItems, selectDebugEvents, useChatStore, type RenderItem } from '../store';
import { modelLabelFor } from '../engines';
import {
	loadUserTurnVariant,
	subscribeUserTurnVariant,
	type UserTurnVariant,
} from '../user-turn-variant';
import { ToolCallCard } from './tool-call-card';
import { ArtifactPill } from './artifact-pill';
import { PermissionDialog } from './permission-dialog';
import { Markdown } from '@/components/markdown';
import { formatRelativeTime } from '@/lib/relative-time';

interface ThreadProps {
	threadId: string | null;
	className?: string;
	/** Kept for API compat; auto-scroll is now handled by Conversation. */
	autoScroll?: boolean;
	/** Phase 8: invoked when the user clicks "Branch from here" on an
	 *  assistant turn. `upToTurn` is the user-turn count up to (and
	 *  including) the message being forked from. The caller is responsible
	 *  for the actual `chatForkSession` call + route navigation so Thread
	 *  stays route-agnostic. */
	onBranch?: (upToTurn: number) => void;
}

/** ADR-013 §7 OQ#3: fork is only supported on engines whose resume +
 *  fork mechanics are pinned. Claude Code is the original; Gemini's
 *  `--resume <index>` / `--session-id <uuid>` is enough to fork.
 *  Codex's `codex fork` subcommand exists but its wire shape isn't
 *  verified yet; cursor-agent has no runtime adapter. Until those land
 *  we gate the Branch affordance to this set. */
const FORK_SUPPORTED_ENGINES: ReadonlySet<string> = new Set(['claude-code', 'gemini']);

function normaliseEngineId(id: string | null | undefined): string | null {
	if (!id) return null;
	if (id === 'acp' || id === 'cli') return 'claude-code';
	return id;
}

function engineLabelFromId(id: string | null): string | null {
	if (!id) return null;
	switch (id) {
		case 'claude-code':
			return 'Claude Code';
		case 'gemini':
			return 'Gemini';
		case 'codex':
			return 'Codex';
		case 'cursor-agent':
			return 'Cursor Agent';
		default:
			return id;
	}
}

export function Thread({ threadId, className, onBranch }: ThreadProps) {
	const state = useChatStore((s) => (threadId ? (s.threads[threadId] ?? null) : null));
	const cwd = state?.thread.cwd ?? undefined;
	// ADR-013 §7 OQ#3 fork gating. Read the thread's persisted engine
	// (`engineId` post-0024, falling back to `adapterId` defensively) and
	// only enable the Branch affordance when the engine has a verified
	// fork path. Disabled rows render with a tooltip explaining why.
	const threadEngineId = normaliseEngineId(state?.thread.engineId ?? state?.thread.adapterId);
	const threadEngineLabel = engineLabelFromId(threadEngineId) ?? 'this engine';
	const forkSupported = !!threadEngineId && FORK_SUPPORTED_ENGINES.has(threadEngineId);
	const includeDebug = import.meta.env.DEV;
	const items = useMemo(
		() => (state ? buildRenderItems(state.events, false) : []),
		[state?.events]
	);
	// Phase 8: for each render item, snapshot the user-turn count up to and
	// including the most recent `user_turn`. Used so "Branch from here" on
	// an assistant row can pass a meaningful `upToTurn` to the server. We
	// walk in render order so the count is stable across re-renders even if
	// tool pairs interleave between user + assistant turns.
	const branchTurnByItem = useMemo(() => {
		const out = new Map<string, number>();
		if (!state) return out;
		let userTurnCount = 0;
		for (const it of items) {
			const ev = it.event;
			if ('kind' in ev && ev.kind === 'user_turn') userTurnCount += 1;
			out.set(it.key, userTurnCount);
		}
		return out;
	}, [items, state]);
	// ADR-011 phase 3: per-turn provenance — model id active when each
	// rendered item was emitted. Carries forward from the most-recent
	// `session_init.model`; falls back to `thread.model` for items that
	// land before the first session_init. A mid-session `chat_set_model`
	// only takes effect on next spawn (which emits a fresh session_init),
	// so this carry-forward is faithful to "model in force at the time
	// the turn streamed."
	//
	// Effort tag is not rendered: the wire `ChatEvent` shape has no
	// per-text effort field yet — phase 3 backend (per-event `_meta`)
	// hasn't shipped. Add it next to model once that lands.
	const modelByItem = useMemo<Map<string, string | null>>(() => {
		const out = new Map<string, string | null>();
		let current: string | null = state?.thread.model ?? null;
		for (const it of items) {
			const ev = it.event;
			if ('kind' in ev && ev.kind === 'session_init') {
				current = ev.model;
			}
			out.set(it.key, current);
		}
		return out;
	}, [items, state?.thread.model]);
	// Carry-forward timestamps. `user_turn` rows have a real `createdAt`;
	// the assistant turns that follow inherit it (close enough — claude
	// streams seconds-scale after the user message). Without this, we'd
	// have nothing to feed `formatRelativeTime` for the assistant labels
	// because `ChatEvent`'s text variant doesn't carry a timestamp.
	const timestampByItem = useMemo<Map<string, number | null>>(() => {
		const out = new Map<string, number | null>();
		let lastUserTs: number | null = state?.thread.createdAt ?? null;
		for (const it of items) {
			const ev = it.event;
			if ('kind' in ev && ev.kind === 'user_turn') {
				lastUserTs = ev.createdAt;
			}
			out.set(it.key, lastUserTs);
		}
		return out;
	}, [items, state?.thread.createdAt]);
	// ADR-011 phase 1: identify the last assistant `text` item so we can
	// render the ember streaming-edge under it when the thread is actively
	// streaming. Walk in reverse so the first hit is the tail.
	const streamingTailKey = useMemo<string | null>(() => {
		if (!state || state.status !== 'streaming') return null;
		for (let i = items.length - 1; i >= 0; i--) {
			const it = items[i];
			if ('kind' in it.event && it.event.kind === 'text') return it.key;
		}
		return null;
	}, [items, state]);
	const debugEvents = useMemo(
		() => (includeDebug && state ? selectDebugEvents(state.events) : []),
		[state?.events, includeDebug]
	);

	// User-turn variant — re-render when the user picks a new style in
	// Settings (subscribeUserTurnVariant fires after every setter call).
	const [userTurnVariant, setUserTurnVariant] = useState<UserTurnVariant>(loadUserTurnVariant);
	useEffect(() => subscribeUserTurnVariant(setUserTurnVariant), []);

	if (!threadId || !state) {
		return (
			<div
				className={cn(
					'flex h-full items-center justify-center text-sm text-muted-foreground',
					className
				)}
			>
				<Loader2 className="mr-2 h-4 w-4 animate-spin" />
				Loading thread…
			</div>
		);
	}

	return (
		<Conversation className={cn('h-full', className)}>
			<ConversationContent className="flex-col gap-2 p-0">
				{items.length === 0 ? (
					<ConversationEmptyState
						title="No messages yet"
						description="Send a prompt to start the conversation."
					/>
				) : (
					<ul className="divide-y divide-[var(--rule)]">
						{items.map((item) => (
							<RenderRow
								key={item.key}
								item={item}
								threadId={threadId}
								cwd={cwd}
								branchTurn={branchTurnByItem.get(item.key)}
								onBranch={onBranch}
								forkSupported={forkSupported}
								forkUnsupportedHint={
									forkSupported ? undefined : `Fork is not yet supported for ${threadEngineLabel}`
								}
								isStreamingTail={item.key === streamingTailKey}
								model={modelByItem.get(item.key) ?? null}
								timestamp={timestampByItem.get(item.key) ?? null}
								userTurnVariant={userTurnVariant}
							/>
						))}
					</ul>
				)}
				{state.status === 'interrupted' && (
					<div className="flex items-center gap-2 border-t border-[var(--rule)] px-4 py-1.5 text-[10px] uppercase tracking-wider text-[var(--kola-amber)]">
						<AlertCircle className="h-3 w-3" />
						interrupted
					</div>
				)}
				{state.status === 'error' && state.errorMessage && (
					<div className="flex items-center gap-2 border-t border-[var(--rule)] px-4 py-1.5 text-[11px] text-[var(--oxblood)]">
						<CircleAlert className="h-3 w-3 shrink-0" />
						<span className="uppercase tracking-wider text-[10px] mr-1">error</span>
						<span className="truncate normal-case tracking-normal opacity-90">
							{state.errorMessage}
						</span>
					</div>
				)}
				{includeDebug && debugEvents.length > 0 && <DebugStrip events={debugEvents} />}
				<PermissionDialog threadId={threadId} />
			</ConversationContent>
			<ConversationScrollButton />
		</Conversation>
	);
}

function RenderRow({
	item,
	threadId,
	cwd,
	branchTurn,
	onBranch,
	forkSupported,
	forkUnsupportedHint,
	isStreamingTail,
	model,
	timestamp,
	userTurnVariant,
}: {
	item: RenderItem;
	threadId: string;
	cwd: string | undefined;
	/** Phase 8: user-turn count up to this row. Passed as `upToTurn` to
	 *  `chatForkSession` when the user clicks "Branch from here". */
	branchTurn?: number;
	onBranch?: (upToTurn: number) => void;
	/** ADR-013 §7 OQ#3: whether the thread's engine supports fork. When
	 *  false, the Branch button is rendered disabled with `forkUnsupportedHint`
	 *  as the tooltip. */
	forkSupported?: boolean;
	forkUnsupportedHint?: string;
	/** ADR-011 phase 1: true on the last assistant `text` row while the
	 *  thread is streaming. Drives the ember-edge animation. */
	isStreamingTail?: boolean;
	/** ADR-011 phase 3: model id in force when this item streamed. Used
	 *  to render the per-turn provenance tag on assistant text rows. */
	model?: string | null;
	/** Carry-forward timestamp (most-recent user_turn createdAt) used for
	 *  the relative-time label on user + assistant turns. */
	timestamp?: number | null;
	/** Picked user-turn rendering style (per Settings → Appearance → Chat). */
	userTurnVariant: UserTurnVariant;
}) {
	const event = item.event;

	if ('kind' in event && event.kind === 'tool_pair') {
		return (
			<li className="px-4 py-3">
				<ToolCallCard pair={event.pair} threadId={threadId} />
			</li>
		);
	}

	switch (event.kind) {
		case 'session_init':
			return (
				<Row icon={Bot} tone="info" label="session">
					{event.model ?? 'unknown model'} · cwd {event.cwd ?? '—'}
					{event.permissionMode && (
						<span className="ml-2 text-muted-foreground">· {event.permissionMode}</span>
					)}
				</Row>
			);
		case 'text': {
			// 2026-05-18 design: assistant turns have no 80px label gutter.
			// Label is an inline mono row above the body: a faint dot, the
			// model name, a middot, and the relative time. The "Assistant"
			// word is dropped — model name is identity enough.
			// Phase 8: "Branch from here" affordance hovers top-right.
			const canBranch = onBranch && branchTurn != null;
			return (
				<li className="group relative px-4 py-5">
					<div className="mb-2 flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.22em] text-[var(--chip-carve)]">
						<span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--chip-carve)]" />
						{model && (
							<>
								<span className="text-[var(--kola-amber-soft)]">{modelLabelFor(model)}</span>
								<span>·</span>
							</>
						)}
						<span>{timestamp != null ? formatRelativeTime(timestamp) : 'now'}</span>
					</div>
					<Markdown
						content={event.delta}
						cwd={cwd}
						density="compact"
						className="text-sm leading-relaxed"
					/>
					{isStreamingTail && (
						// ADR-011 phase 1: ember streaming edge — animated gradient
						// strip under the actively streaming turn.
						<div className="streaming-edge mt-2 h-px" aria-hidden />
					)}
					{canBranch && (
						<button
							type="button"
							onClick={() => {
								if (forkSupported === false) return;
								onBranch(branchTurn);
							}}
							disabled={forkSupported === false}
							className={cn(
								'absolute right-4 top-4 inline-flex items-center gap-1 rounded-sm border border-[var(--rule)] bg-transparent px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-[var(--chip-carve)] opacity-0 transition-colors group-hover:opacity-100',
								forkSupported === false
									? 'cursor-not-allowed opacity-40 group-hover:opacity-40'
									: 'hover:border-[var(--kola-amber)] hover:bg-[var(--rule-soft)] hover:text-[var(--kola-amber)]'
							)}
							title={
								forkSupported === false
									? (forkUnsupportedHint ?? 'Fork is not supported on this engine')
									: 'Branch from here — fork this thread into a new conversation that continues from this assistant turn'
							}
						>
							<GitBranch className="h-3 w-3" />
							Branch
						</button>
					)}
				</li>
			);
		}
		case 'thinking':
			// Some claude accounts/models return thinking signature-only: the
			// `thinking` block ships a cryptographic signature but no plaintext
			// (no `thinking_delta` is ever emitted, so the delta is empty).
			// Render a compact "encrypted" note rather than a misleading empty
			// "(0 chars)" disclosure that expands to nothing.
			if (event.delta.length === 0) {
				return (
					<Row icon={Brain} tone="muted" label="thinking">
						<span className="text-xs italic text-muted-foreground">
							thinking · encrypted (no transcript returned)
						</span>
					</Row>
				);
			}
			return (
				<Row icon={Brain} tone="muted" label="thinking">
					<details>
						<summary className="cursor-pointer text-xs text-muted-foreground">
							thinking ({event.delta.length} chars)
						</summary>
						<p className="mt-2 whitespace-pre-wrap text-xs italic text-muted-foreground">
							{event.delta}
						</p>
					</details>
				</Row>
			);
		case 'artifact':
			return (
				<Row icon={null} tone="artifact" label="artifact">
					<ArtifactPill path={event.path} mime={event.mime} producedBy={event.producedBy} />
				</Row>
			);
		case 'user_turn': {
			// 2026-05-18 design: drop the "you" label entirely. Identity is
			// carried by right-alignment and the variant treatment; the only
			// label-row content is the relative timestamp. Variant class
			// applies to the inner wrapper so each style gets its own
			// container shape (bubble / accent / frame) or non-shape
			// (baseline). Max-width stays at 78% — matches design.
			const variantClass = `utv-${userTurnVariant}`;
			const bubbleLike =
				userTurnVariant === 'bubble' || userTurnVariant === 'accent' || userTurnVariant === 'frame';
			return (
				<li
					className={cn(
						'flex justify-end px-4 py-5',
						userTurnVariant === 'baseline' && 'border-b border-[var(--rule)]'
					)}
				>
					<div className={cn('min-w-0 max-w-[78%]', variantClass)}>
						<div
							className={cn(
								'mb-1 font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--chip-carve)]',
								bubbleLike ? 'text-left' : 'text-right'
							)}
						>
							{formatRelativeTime(event.createdAt)}
						</div>
						<Markdown
							content={event.text}
							cwd={cwd}
							density="compact"
							className={cn('text-sm leading-relaxed', bubbleLike ? 'text-left' : 'text-right')}
						/>
					</div>
				</li>
			);
		}
		case 'system_hook':
			if (event.hookEvent === 'cancel') {
				return (
					<li className="flex items-center gap-2 px-4 py-2 text-[10px] uppercase tracking-wider text-[var(--kola-amber)]">
						<AlertCircle className="h-3 w-3" />
						interrupted by user
					</li>
				);
			}
			return (
				<Row icon={Bot} tone="muted" label={`hook · ${event.hookEvent}`}>
					{event.name && <code className="text-xs text-muted-foreground">{event.name}</code>}
				</Row>
			);
		case 'rate_limit':
			return (
				<Row icon={CircleAlert} tone="error" label="rate-limit">
					<pre className="text-[11px] text-muted-foreground">{tryStringify(event.info)}</pre>
				</Row>
			);
		case 'done':
			return (
				<li className="flex items-center gap-3 border-t border-[var(--rule)] px-4 py-2 font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--chip-carve)]">
					<CheckCircle2 className="h-3 w-3 shrink-0" />
					<span>{event.stopReason ?? 'finished'}</span>
					{event.totalCostUsd != null && (
						<span className="text-[var(--kola-amber)]">· ${event.totalCostUsd.toFixed(4)}</span>
					)}
					{event.durationMs != null && <span>· {event.durationMs}ms</span>}
				</li>
			);
		case 'parse_error':
		case 'unknown':
			return null; // surfaced via DebugStrip in dev
		case 'tool_use':
		case 'tool_result':
			return null; // surfaced via tool_pair render path
		default:
			return null;
	}
}

type Tone = 'user' | 'assistant' | 'tool' | 'artifact' | 'info' | 'muted' | 'error';

// v2 layout uses hairline rules between turns, not row backgrounds.
// Kept the Tone union so the label color can still vary per row kind.
const TONE_LABEL_CLASS: Record<Tone, string> = {
	user: 'text-[var(--chip-carve)]',
	assistant: 'text-[var(--chip-carve)]',
	tool: 'text-[var(--kola-amber)]',
	artifact: 'text-[var(--kola-amber)]',
	info: 'text-[var(--chip-carve)]',
	muted: 'text-[var(--chip-carve)]',
	error: 'text-[var(--oxblood)]',
};

function Row({
	icon: Icon,
	tone,
	label,
	children,
}: {
	icon: React.ComponentType<{ className?: string }> | null;
	tone: Tone;
	label: string;
	children: React.ReactNode;
}) {
	return (
		<li className="flex gap-4 px-4 py-5">
			<div
				className={cn(
					'flex w-20 shrink-0 items-start gap-1 pt-0.5 font-mono text-[10px] uppercase tracking-[0.2em]',
					TONE_LABEL_CLASS[tone]
				)}
			>
				{Icon && <Icon className="h-3 w-3" />}
				<span>{label}</span>
			</div>
			<div className="min-w-0 flex-1">{children}</div>
		</li>
	);
}

function tryStringify(value: unknown): string {
	if (typeof value === 'string') return value;
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function DebugStrip({ events }: { events: ChatEvent[] }) {
	return (
		<details className="border-t-2 border-dashed border-border/60 bg-muted/10 px-4 py-2 text-[11px]">
			<summary className="cursor-pointer text-muted-foreground">
				dev: {events.length} unknown / parse-error event{events.length === 1 ? '' : 's'}
			</summary>
			<ul className="mt-2 space-y-1">
				{events.map((e, i) => (
					<li
						key={i}
						className="rounded border border-border/40 bg-background p-2 font-mono text-[10px]"
					>
						<span className="mr-2 uppercase tracking-wide text-muted-foreground">{e.kind}</span>
						<pre className="mt-1 whitespace-pre-wrap break-words">{tryStringify(e)}</pre>
					</li>
				))}
			</ul>
		</details>
	);
}
