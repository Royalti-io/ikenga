// Side-pane Terminal panel entry point.
//
// Gates ownership: if the tab is currently attached to an Artifact Studio
// loupe, the side pane keeps its tab strip entry but the panel body shows
// a placeholder pointing at the owning Studio (D4). `SingleTerminal` stays
// ownership-agnostic so Studio can mount it directly without the gate.

import { ArrowUpRight, ExternalLink, Undo2 } from 'lucide-react';
import { useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { FeedbackState } from '@/components/ui/feedback-state';
import { IconButton } from '@/components/ui/icon-button';
import { findLeaf, getActiveView } from '@/lib/panes/pane-reducer';
import { usePaneStore } from '@/lib/panes/pane-store';
import { spawnWindow } from '@/lib/tauri-cmd';
import {
	markSurfaceDetached,
	syncDetachedSurfaces,
	useIsSurfaceDetached,
} from '@/lib/window/detached-surfaces';
import { type TerminalTab, useTerminalStore } from '@/terminal/session-store';
import { SingleTerminal } from '@/terminal/single-terminal';
import { DetachedSurfacePlaceholder } from './detached-placeholder';

interface TerminalViewProps {
	sessionId: string;
}

export function TerminalView({ sessionId }: TerminalViewProps) {
	const tab = useTerminalStore((s) => s.tabs.find((t) => t.id === sessionId));

	// Is the pane currently hosting THIS terminal session the focused pane?
	// Threaded down to XTermHost so a cache-hit remount (see xterm-host.tsx)
	// only steals DOM focus when the user is actually looking at this pane —
	// terminal-view.tsx doesn't receive its own paneId as a prop, so this
	// resolves it by searching the pane tree for the focused leaf's active
	// view instead of threading a new prop through pane-views.tsx.
	const isFocused = usePaneStore((s) => {
		const leaf = findLeaf(s.root, s.focusedId);
		if (!leaf) return false;
		const active = getActiveView(leaf);
		return active.kind === 'terminal' && active.sessionId === sessionId;
	});

	// Pop-out: spawn a thin single-surface window that ATTACHES to this
	// terminal's live core PTY. Encodes the real PTY id (not the pane session
	// id) in the surface_set so the detached TerminalSurface can attach over
	// the shared `pty://<id>` stream. (plans/multi-window WP-08.)
	const ptyId = tab?.ptyId ?? null;
	const surfaceId = ptyId ? `terminal:${ptyId}` : null;
	const isDetached = useIsSurfaceDetached(surfaceId);
	const handlePopOut = useCallback(() => {
		if (!ptyId || !surfaceId) return;
		const label = `detached-terminal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
		// Optimistically mark detached so this pane swaps to the placeholder
		// immediately instead of briefly duplicating the live terminal.
		markSurfaceDetached(surfaceId, label);
		void spawnWindow({
			label,
			kind: 'single-surface',
			surface_set: [surfaceId],
			project_id: null,
			layout_key: label,
		}).catch((e) => {
			console.warn('pop-out terminal:', e);
			// Reconcile the optimistic mark if the window never opened.
			void syncDetachedSurfaces();
		});
	}, [ptyId, surfaceId]);

	if (tab && tab.owner.kind === 'studio') {
		const ownerPaneId = tab.owner.paneId;
		return (
			<StudioOwnedPlaceholder
				tab={tab}
				paneId={ownerPaneId}
				artifactPath={tab.owner.artifactPath}
				onReclaim={() => useTerminalStore.getState().detachFromStudio(sessionId)}
				onOpenStudio={() => usePaneStore.getState().focusPane(ownerPaneId)}
			/>
		);
	}

	// Popped out into its own window — render the reclaim placeholder, not the
	// live duplicate (both windows would otherwise drive the same core PTY).
	if (isDetached && surfaceId) {
		return <DetachedSurfacePlaceholder surfaceId={surfaceId} noun="terminal" />;
	}

	return (
		<div className="relative h-full w-full">
			{ptyId && (
				<div className="absolute right-1.5 top-1.5 z-50">
					<IconButton
						onClick={handlePopOut}
						title="Pop out — open this terminal in a detached window"
						aria-label="Pop out terminal"
					>
						<ArrowUpRight className="h-3.5 w-3.5" />
					</IconButton>
				</div>
			)}
			<SingleTerminal sessionId={sessionId} isFocused={isFocused} />
		</div>
	);
}

interface StudioOwnedPlaceholderProps {
	tab: TerminalTab;
	paneId: string;
	artifactPath: string;
	onReclaim: () => void;
	onOpenStudio: () => void;
}

function StudioOwnedPlaceholder({
	tab,
	paneId,
	artifactPath,
	onReclaim,
	onOpenStudio,
}: StudioOwnedPlaceholderProps) {
	const filename = artifactPath.split('/').filter(Boolean).pop() ?? artifactPath;
	return (
		<FeedbackState
			variant="empty"
			fill
			icon={ExternalLink}
			heading={tab.title}
			body={
				<span className="flex flex-col items-center gap-1">
					<span className="font-mono text-[10px] uppercase tracking-[0.14em]">
						In Studio · pane {paneId.slice(0, 6)}
					</span>
					<span className="font-mono text-[11px]" title={artifactPath}>
						attached to {filename}
					</span>
				</span>
			}
			action={
				<>
					<Button size="sm" variant="outline" onClick={onOpenStudio} className="h-7 px-3 text-xs">
						<ExternalLink className="mr-1 h-3 w-3" />
						Open Studio
					</Button>
					<Button size="sm" onClick={onReclaim} className="h-7 px-3 text-xs">
						<Undo2 className="mr-1 h-3 w-3" />
						Reclaim
					</Button>
				</>
			}
		/>
	);
}
