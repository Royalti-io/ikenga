// Studio's engine chat panel.
//
// Reuses the shell's existing chat module (Thread render + useChatActions
// for sending + useThread for hydration). The chat thread is keyed off the
// artifact's on-disk path so re-opening Studio resumes the same conversation
// — mapping kept in localStorage under STUDIO_THREAD_KEY_PREFIX.
//
// Two Studio-specific affordances on top of the standard chat:
//
//   1. **Pending comment chip.** When the comment-mode selector picker
//      freezes an element, the parent passes a `{selector}` chip in via
//      props. The chip renders above the input and, on submit, gets
//      prepended as a structured line so the engine sees both the
//      targeted element and the user's instruction.
//
//   2. **Engine-edit auto-save.** The parent passes `onEngineEdit`; the
//      Studio chat surfaces a (future) hook for the engine to write back
//      file contents. v0 wires the prop but does not yet round-trip
//      engine-driven file rewrites — the plumbing is here for the
//      next pass (ACP tool-result interception lands in Phase 4 follow-up).
//
// The Composer used here is intentionally smaller than the full one in
// `chat/ui/composer.tsx`: no slash-command palette, no image upload, no
// model/effort dropdowns. Studio's chat is scoped to "edit this artifact"
// — the noise belongs on the main chat surface.

import { Loader2, MessageSquare, Square, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Thread, useChatActions, useThread, useThreadState, mintThreadId } from '@/chat';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/components/ui/utils';

const STUDIO_THREAD_KEY_PREFIX = 'ikenga.studio.thread:';

interface StudioEngineChatProps {
	path: string;
	pendingChip: { selector: string } | null;
	onConsumeChip: () => void;
	/** v0: prop is wired but engine-driven rewrites aren't yet round-tripped
	 *  through ACP tool-results. The handler is here so the chip+submit flow
	 *  can hand off a candidate rewrite when we add that next. */
	onEngineEdit: (next: string) => Promise<void>;
}

export function StudioEngineChat({ path, pendingChip, onConsumeChip }: StudioEngineChatProps) {
	const threadId = useStudioThreadId(path);
	const { loading, error } = useThread(threadId);

	if (error) {
		return (
			<div className="flex h-full w-full items-center justify-center p-4 text-xs text-destructive">
				Chat failed: {error}
			</div>
		);
	}
	if (loading || !threadId) {
		return (
			<div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground">
				<Loader2 className="mr-2 h-3 w-3 animate-spin" />
				Loading chat…
			</div>
		);
	}
	return (
		<div className="flex h-full w-full flex-col">
			<div className="flex shrink-0 items-center gap-1.5 border-b border-border bg-muted/20 px-2 py-1 text-[10px] text-muted-foreground">
				<MessageSquare className="h-3 w-3" />
				<span className="font-mono">{threadId.slice(0, 8)}…</span>
			</div>
			<Thread threadId={threadId} className="flex-1" />
			<StudioComposer
				threadId={threadId}
				pendingChip={pendingChip}
				onConsumeChip={onConsumeChip}
			/>
		</div>
	);
}

/** Look up (or mint) the stable thread id for this artifact path. The
 *  mapping lives in localStorage so reopening Studio resumes the same
 *  conversation. New paths get a fresh uuid. */
function useStudioThreadId(path: string): string | null {
	const [id, setId] = useState<string | null>(null);
	useEffect(() => {
		const key = STUDIO_THREAD_KEY_PREFIX + path;
		try {
			const existing = window.localStorage.getItem(key);
			if (existing) {
				setId(existing);
				return;
			}
		} catch {
			// localStorage unavailable — fall through and mint, but we won't
			// persist. Future opens will mint a fresh thread.
		}
		const fresh = mintThreadId();
		try {
			window.localStorage.setItem(key, fresh);
		} catch {
			// noop
		}
		setId(fresh);
	}, [path]);
	return id;
}

interface StudioComposerProps {
	threadId: string;
	pendingChip: { selector: string } | null;
	onConsumeChip: () => void;
}

function StudioComposer({ threadId, pendingChip, onConsumeChip }: StudioComposerProps) {
	const [draft, setDraft] = useState('');
	const actions = useChatActions(threadId);
	const state = useThreadState(threadId);
	const streaming = state?.status === 'streaming';

	const submit = useCallback(async () => {
		const text = draft.trim();
		if (!text && !pendingChip) return;
		const composed = pendingChip
			? `[Selector: \`${pendingChip.selector}\`]\n\n${text || '(no instruction — review this element)'}`
			: text;
		setDraft('');
		if (pendingChip) onConsumeChip();
		await actions.send(composed);
	}, [draft, pendingChip, actions, onConsumeChip]);

	const placeholder = useMemo(() => {
		if (pendingChip) return 'Describe what to do with this element…';
		return 'Edit the artifact…';
	}, [pendingChip]);

	return (
		<div className="shrink-0 border-t border-border bg-background p-2">
			{pendingChip && (
				<div className="mb-2 flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[10px]">
					<span className="font-mono text-amber-700 dark:text-amber-400">
						{pendingChip.selector}
					</span>
					<button
						type="button"
						onClick={onConsumeChip}
						className="ml-auto text-muted-foreground hover:text-foreground"
						aria-label="Clear comment target"
					>
						<X className="h-3 w-3" />
					</button>
				</div>
			)}
			<Textarea
				value={draft}
				onChange={(e) => setDraft(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === 'Enter' && !e.shiftKey) {
						e.preventDefault();
						void submit();
					}
				}}
				placeholder={placeholder}
				className={cn('min-h-[2.5rem] resize-none text-xs', streaming && 'opacity-60')}
				disabled={streaming && !pendingChip}
			/>
			<div className="mt-1.5 flex items-center justify-between gap-2">
				<span className="text-[9px] text-muted-foreground">
					{streaming ? 'Streaming…' : 'Enter to send · Shift+Enter for newline'}
				</span>
				{streaming ? (
					<Button
						size="sm"
						variant="outline"
						onClick={() => void actions.cancel()}
						className="h-6 px-2 text-[10px]"
					>
						<Square className="mr-1 h-2.5 w-2.5" />
						Stop
					</Button>
				) : (
					<Button
						size="sm"
						onClick={() => void submit()}
						disabled={!actions.canSend || (!draft.trim() && !pendingChip)}
						className="h-6 px-3 text-[10px]"
					>
						Send
					</Button>
				)}
			</div>
		</div>
	);
}
