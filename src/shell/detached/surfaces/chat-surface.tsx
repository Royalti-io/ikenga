// Detached chat surface (plans/multi-window WP-06).
//
// Renders a live chat thread in a thin detached window — no activity-bar,
// sidebar, or pane-group chrome (those live in the primary workspace only).
//
// Session ownership STAYS in the Rust core (`chat_sessions` SQLite +
// `chat://session/…` event channels); this surface SUBSCRIBES and renders,
// it NEVER forks session state. The Thread + Composer components read from
// the shared Zustand chat store, which the adapter keeps in sync over the
// existing `chat://session/<id>` Tauri event channel — same wire as the
// primary window, no mirroring needed.
//
// The pop-out affordance in `pane/views/chat-view.tsx` encodes the threadId
// in the `surface_set` entry: `"chat:<threadId>"`. The surface registry
// resolves by prefix (`"chat"`); this component extracts the suffix.
// The threadId is a UUID (no colons), so splitting on the first `:` is safe.
//
// Live-sync verification (detached chat stays in sync while streaming):
// needs a built + running shell — reported as needing live verification.

import { MessageSquare } from 'lucide-react';

import { AdapterSwitcher, Composer, Thread, useThread } from '@/chat';
import { FeedbackState } from '@/components/ui/feedback-state';

import type { DetachedSurfaceProps } from '../registry';

/** Extract the threadId encoded in `"chat:<threadId>"` by the pop-out. */
function parseThreadId(surfaces: string[]): string | null {
	const entry = surfaces[0] ?? '';
	const colon = entry.indexOf(':');
	if (colon < 1) return null;
	const id = entry.slice(colon + 1);
	return id.length > 0 ? id : null;
}

export default function ChatSurface({ ctx }: DetachedSurfaceProps) {
	const threadId = parseThreadId(ctx.surfaces);

	return (
		<div className="flex h-full w-full flex-col">
			<header
				className="flex shrink-0 items-center justify-between border-b border-border bg-muted/20 px-3 py-1.5"
				style={{ height: 'var(--tab-h, 32px)' }}
			>
				<div className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
					<MessageSquare className="h-3 w-3 shrink-0" />
					{threadId ? (
						<span title={threadId}>{threadId.slice(0, 8)}…</span>
					) : (
						<span>chat</span>
					)}
				</div>
				<AdapterSwitcher />
			</header>
			{threadId ? (
				<ChatBody threadId={threadId} />
			) : (
				<FeedbackState
					variant="empty"
					fill
					icon={MessageSquare}
					heading="No session"
					body="Open this window via the chat pane pop-out button."
				/>
			)}
		</div>
	);
}

function ChatBody({ threadId }: { threadId: string }) {
	// useThread hydrates the thread from SQLite + JSONL and attaches the live
	// event subscription (same path as the primary-window ChatView). Because the
	// adapter writes into the shared Zustand store keyed by threadId, events
	// flowing in the primary window will land here too — no second subscription.
	const { loading, error } = useThread(threadId);

	if (loading) {
		return <FeedbackState variant="loading" fill heading="Loading session…" />;
	}
	if (error) {
		return <FeedbackState variant="error" fill heading="Session error" body={error} />;
	}
	return (
		<>
			<Thread threadId={threadId} className="flex-1" />
			<Composer threadId={threadId} />
		</>
	);
}
