/**
 * ADR-011 phase 2 — dedicated viewer pane for a tool call result.
 *
 * Routes the per-tool renderer at `density='full'` into a full-height
 * pane surface. Reads the tool_use + tool_result from the chat store
 * by `toolUseId`, so the viewer follows live updates (e.g. a Bash
 * command's stdout streaming in after the pane is opened).
 *
 * If the tool pair is missing from the store (e.g. thread was closed),
 * the view renders a "stale" placeholder rather than crashing.
 */

import { useMemo } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { ExternalLink } from 'lucide-react';
import { findToolPairById, useChatStore } from '@/chat';
import { FeedbackState } from '@/components/ui/feedback-state';
import { ToolRendererDispatch } from '@/chat/ui/tool-renderers';

interface ToolOutputViewProps {
	threadId: string;
	toolUseId: string;
}

export function ToolOutputView({ threadId, toolUseId }: ToolOutputViewProps) {
	const navigate = useNavigate();
	// Select the stable `events` array, then derive the pair in a memo. Calling
	// `findToolPairById` *inside* the selector returns a fresh `{use,result}`
	// object every render, which Zustand's getSnapshot compares by reference —
	// an unstable snapshot drives an infinite update loop ("Maximum update depth
	// exceeded"). Selecting the array (stable until events actually change) and
	// memoizing the derivation fixes it.
	const events = useChatStore((s) => s.threads[threadId]?.events);
	const pair = useMemo(() => findToolPairById(events ?? [], toolUseId), [events, toolUseId]);

	if (!pair) {
		return (
			<FeedbackState
				variant="stale"
				fill
				body="tool call not found in this thread · viewer stale"
			/>
		);
	}

	const isError = pair.result?.isError === true;
	const isPending = pair.result == null;

	function handleJumpToChat() {
		void navigate({
			to: '/sessions/$sessionId',
			params: { sessionId: threadId },
		});
	}

	return (
		<div className="flex h-full flex-col">
			<div className="flex items-center gap-2 border-b border-[var(--rule)] bg-[var(--bg-raised)] px-4 py-2 font-mono text-[9px] uppercase tracking-[0.22em]">
				<span className="text-[var(--kola-amber)]">◾</span>
				<span className="truncate text-foreground">{pair.use.name}</span>
				{isError && <span className="text-[var(--oxblood)]">· error</span>}
				{isPending && <span className="text-[var(--ember)]">· running</span>}
				<button
					type="button"
					onClick={handleJumpToChat}
					className="ml-auto inline-flex items-center gap-1 rounded-sm border border-[var(--rule)] bg-transparent px-1.5 py-0.5 text-[var(--chip-carve)] transition-colors hover:border-[var(--kola-amber)] hover:text-[var(--kola-amber)]"
					title="Jump to the chat thread that produced this tool call"
				>
					jump to chat
					<ExternalLink className="h-3 w-3" />
				</button>
			</div>
			<div className="flex-1 overflow-auto px-4 py-3">
				<ToolRendererDispatch pair={pair} threadId={threadId} density="full" />
			</div>
		</div>
	);
}
