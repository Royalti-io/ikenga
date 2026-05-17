// Studio's engine chat panel.
//
// Reuses the shell's existing chat module (Thread render + useChatActions
// for sending + useThread for hydration). The chat thread is keyed off the
// artifact's on-disk path so re-opening Studio resumes the same conversation
// — mapping kept in localStorage under STUDIO_THREAD_KEY_PREFIX.
//
// The composer is intentionally smaller than the full one in
// `chat/ui/composer.tsx`: no slash-command palette, no image upload, no
// model/effort dropdowns. Studio's chat is scoped to "edit this artifact"
// — the noise belongs on the main chat surface.
//
// `onEngineEdit` is wired but engine-driven file rewrites aren't yet
// round-tripped through ACP tool-results — the handler is here so the
// next pass can plug in.

import { Loader2, MessageSquare, Square } from 'lucide-react';
import { useCallback, useState } from 'react';
import { Thread, useChatActions, useThread, useThreadState } from '@/chat';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/components/ui/utils';
import { useStudioThreadId } from '@/lib/artifact/studio-thread';

interface StudioEngineChatProps {
	path: string;
	/** v0: prop is wired but engine-driven rewrites aren't yet round-tripped
	 *  through ACP tool-results. Reserved for the next pass. */
	onEngineEdit: (next: string) => Promise<void>;
}

export function StudioEngineChat({ path }: StudioEngineChatProps) {
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
			<StudioComposer threadId={threadId} />
		</div>
	);
}

interface StudioComposerProps {
	threadId: string;
}

function StudioComposer({ threadId }: StudioComposerProps) {
	const [draft, setDraft] = useState('');
	const actions = useChatActions(threadId);
	const state = useThreadState(threadId);
	const streaming = state?.status === 'streaming';

	const submit = useCallback(async () => {
		const text = draft.trim();
		if (!text) return;
		setDraft('');
		await actions.send(text);
	}, [draft, actions]);

	return (
		<div className="shrink-0 border-t border-border bg-background p-2">
			<Textarea
				value={draft}
				onChange={(e) => setDraft(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === 'Enter' && !e.shiftKey) {
						e.preventDefault();
						void submit();
					}
				}}
				placeholder="Edit the artifact…"
				className={cn('min-h-[2.5rem] resize-none text-xs', streaming && 'opacity-60')}
				disabled={streaming}
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
						disabled={!actions.canSend || !draft.trim()}
						className="h-6 px-3 text-[10px]"
					>
						Send
					</Button>
				)}
			</div>
		</div>
	);
}
