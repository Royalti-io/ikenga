import { MessageSquare } from 'lucide-react';
import { AdapterSwitcher, Composer, Thread, useThread } from '@/chat';
import { FeedbackState } from '@/components/ui/feedback-state';

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
	return (
		<div className="flex h-full w-full flex-col">
			<div className="flex shrink-0 items-center justify-between border-b border-border bg-muted/20 px-3 py-1.5">
				<div className="flex items-center gap-2 text-[11px] text-muted-foreground">
					<MessageSquare className="h-3 w-3" />
					<span className="font-mono">{threadId.slice(0, 8)}…</span>
				</div>
				<AdapterSwitcher />
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
