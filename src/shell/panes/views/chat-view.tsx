import { ArrowUpRight, MessageSquare } from 'lucide-react';
import { useCallback } from 'react';
import { AdapterSwitcher, Composer, Thread, useThread } from '@/chat';
import { FeedbackState } from '@/components/ui/feedback-state';
import { IconButton } from '@/components/ui/icon-button';
import { spawnWindow } from '@/lib/tauri-cmd';
import {
	markSurfaceDetached,
	syncDetachedSurfaces,
	useIsSurfaceDetached,
} from '@/lib/window/detached-surfaces';
import { DetachedSurfacePlaceholder } from './detached-placeholder';

interface ChatViewProps {
	/** Stable thread id (frontend-minted uuid). For back-compat with v1
	 *  pane-view shapes, the prop is still called `sessionId`. */
	sessionId: string;
}

export function ChatView({ sessionId }: ChatViewProps) {
	if (!sessionId) {
		return (
			<FeedbackState
				variant="empty"
				fill
				icon={MessageSquare}
				heading="No chat selected"
				body={
					<>
						Open a chat from the dock + menu or use <span className="font-mono">⌘⇧N</span>.
					</>
				}
			/>
		);
	}
	return <ChatViewBody threadId={sessionId} />;
}

function ChatViewBody({ threadId }: { threadId: string }) {
	const { loading, error } = useThread(threadId);

	// Pop-out: spawn a thin single-surface window for this chat thread.
	// The threadId is encoded in the surface_set entry ("chat:<threadId>") so
	// the detached ChatSurface can extract it from ctx.surfaces[0].
	// A timestamp + random suffix keeps the label unique even if the user pops
	// out multiple sessions within the same millisecond (Tauri window labels
	// must be unique; a collision would reject the second spawn).
	const surfaceId = `chat:${threadId}`;
	const isDetached = useIsSurfaceDetached(surfaceId);
	const handlePopOut = useCallback(() => {
		const label = `detached-chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
		// Optimistically mark detached so this pane swaps to the placeholder
		// immediately instead of briefly duplicating the live chat.
		markSurfaceDetached(surfaceId, label);
		void spawnWindow({
			label,
			kind: 'single-surface',
			surface_set: [surfaceId],
			project_id: null,
			layout_key: label,
		}).catch((e) => {
			console.warn('pop-out chat:', e);
			// Reconcile the optimistic mark if the window never opened.
			void syncDetachedSurfaces();
		});
	}, [surfaceId]);

	// Popped out into its own window — render the reclaim placeholder, not the
	// live duplicate.
	if (isDetached) {
		return <DetachedSurfacePlaceholder surfaceId={surfaceId} noun="chat" />;
	}

	return (
		<div className="flex h-full w-full flex-col">
			<div className="flex shrink-0 items-center justify-between border-b border-border bg-muted/20 px-3 py-1.5">
				<div className="flex items-center gap-2 text-[11px] text-muted-foreground">
					<MessageSquare className="h-3 w-3" />
					<span className="font-mono">{threadId.slice(0, 8)}…</span>
				</div>
				<div className="flex items-center gap-1">
					<IconButton
						onClick={handlePopOut}
						title="Pop out — open this chat in a detached window"
						aria-label="Pop out chat"
					>
						<ArrowUpRight className="h-3.5 w-3.5" />
					</IconButton>
					<AdapterSwitcher />
				</div>
			</div>
			{loading ? (
				<FeedbackState variant="loading" fill heading="Loading…" />
			) : error ? (
				<FeedbackState variant="error" fill heading="Chat error" body={error} />
			) : (
				<>
					<Thread threadId={threadId} className="flex-1" />
					<Composer threadId={threadId} />
				</>
			)}
		</div>
	);
}
