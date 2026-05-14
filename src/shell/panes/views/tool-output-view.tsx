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

import { useNavigate } from '@tanstack/react-router';
import { ExternalLink } from 'lucide-react';
import { findToolPairById, useChatStore } from '@/chat';
import { ToolRendererDispatch } from '@/chat/ui/tool-renderers';

interface ToolOutputViewProps {
	threadId: string;
	toolUseId: string;
}

export function ToolOutputView({ threadId, toolUseId }: ToolOutputViewProps) {
	const navigate = useNavigate();
	const pair = useChatStore((s) => {
		const events = s.threads[threadId]?.events ?? [];
		return findToolPairById(events, toolUseId);
	});

	if (!pair) {
		return (
			<div className="flex h-full items-center justify-center px-4 py-8 text-center font-mono text-[11px] uppercase tracking-wider text-[var(--chip-carve)]">
				tool call not found in this thread · viewer stale
			</div>
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
