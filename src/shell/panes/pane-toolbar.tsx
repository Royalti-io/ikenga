import {
	Pencil,
	RefreshCw,
	SplitSquareHorizontal,
	SplitSquareVertical,
	X,
} from 'lucide-react';
import type { PaneId } from '@/lib/panes/types';
import { usePaneStore } from '@/lib/panes/pane-store';
import { findLeaf } from '@/lib/panes/pane-reducer';
import { cn } from '@/components/ui/utils';

interface PaneToolbarProps {
	paneId: PaneId;
}

export function PaneToolbar({ paneId }: PaneToolbarProps) {
	const splitPane = usePaneStore((s) => s.splitPane);
	const closePane = usePaneStore((s) => s.closePane);
	const refreshPane = usePaneStore((s) => s.refreshPane);
	const replaceView = usePaneStore((s) => s.replaceActiveViewAndPushHistory);
	const canSplit = usePaneStore((s) => s.canSplit());
	const leafCount = usePaneStore((s) => s.leafCount());

	// Look up the active tab for this pane so we can show context-specific
	// actions (Open in Studio on artifact panes). Two-step lookup because the
	// store keeps panes in a tree, not flat by id.
	const activeView = usePaneStore((s) => {
		const leaf = findLeaf(s.root, paneId);
		return leaf?.tabs[leaf.activeTabIdx] ?? null;
	});

	const splitDisabled = !canSplit;
	const splitTitle = splitDisabled ? 'Max 6 panes' : undefined;
	const closeDisabled = leafCount <= 1;

	const showStudioToggle =
		(activeView?.kind === 'artifact' || activeView?.kind === 'artifact-studio') &&
		isHtmlArtifactPath(activeView.path);

	return (
		<div className="flex items-center gap-0.5">
			{showStudioToggle && activeView.kind === 'artifact' && (
				<StudioToggleButton
					mode="open"
					onClick={() => replaceView(paneId, { kind: 'artifact-studio', path: activeView.path })}
				/>
			)}
			{showStudioToggle && activeView.kind === 'artifact-studio' && (
				<StudioToggleButton
					mode="close"
					onClick={() => replaceView(paneId, { kind: 'artifact', path: activeView.path })}
				/>
			)}
			<ToolButton
				onClick={() => refreshPane(paneId)}
				title="Refresh pane content"
				aria-label="Refresh pane"
			>
				<RefreshCw className="h-3.5 w-3.5" />
			</ToolButton>
			<ToolButton
				onClick={() => splitPane(paneId, 'horizontal')}
				disabled={splitDisabled}
				title={splitTitle ?? 'Split right (⌘\\)'}
				aria-label="Split right"
			>
				<SplitSquareHorizontal className="h-3.5 w-3.5" />
			</ToolButton>
			<ToolButton
				onClick={() => splitPane(paneId, 'vertical')}
				disabled={splitDisabled}
				title={splitTitle ?? 'Split down (⌘⇧\\)'}
				aria-label="Split down"
			>
				<SplitSquareVertical className="h-3.5 w-3.5" />
			</ToolButton>
			<ToolButton
				onClick={() => closePane(paneId)}
				disabled={closeDisabled}
				title={closeDisabled ? 'Cannot close last pane' : 'Close pane'}
				aria-label="Close pane"
			>
				<X className="h-3.5 w-3.5" />
			</ToolButton>
		</div>
	);
}

function isHtmlArtifactPath(path: string): boolean {
	const lower = path.toLowerCase();
	return lower.endsWith('.html') || lower.endsWith('.htm');
}

interface ToolButtonProps {
	onClick: () => void;
	disabled?: boolean;
	title?: string;
	'aria-label': string;
	children: React.ReactNode;
}

function ToolButton({ onClick, disabled, title, children, ...rest }: ToolButtonProps) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			title={title}
			aria-label={rest['aria-label']}
			className={cn(
				'flex h-6 w-6 items-center justify-center rounded',
				'text-muted-foreground transition-colors',
				'hover:bg-accent hover:text-accent-foreground',
				'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent'
			)}
		>
			{children}
		</button>
	);
}

interface StudioToggleButtonProps {
	mode: 'open' | 'close';
	onClick: () => void;
}

/** Labelled toolbar button for entering or leaving Artifact Studio. The
 *  icon-only ToolButton is too easy to miss for a workspace-level mode
 *  switch; this gives the action its own labelled chip in the toolbar so
 *  the editing surface is discoverable on first artifact open. */
function StudioToggleButton({ mode, onClick }: StudioToggleButtonProps) {
	const isOpen = mode === 'open';
	const label = isOpen ? 'Open in Studio' : 'Close Studio';
	const title = isOpen ? 'Open in Artifact Studio' : 'Close Studio (back to preview)';
	// High-contrast CTA styling. The pane toolbar sits on a slightly-muted
	// strip alongside refresh/split icons, so anything muted or border-only
	// gets lost in the background. Primary background + white text reads as
	// "this is THE action for this pane" at a glance.
	return (
		<button
			type="button"
			onClick={onClick}
			title={title}
			aria-label={title}
			className={cn(
				'mr-2 flex h-6 items-center gap-1.5 rounded px-2.5 text-[11px] font-semibold shadow-sm',
				'transition-colors',
				isOpen
					? 'bg-primary text-primary-foreground hover:bg-primary/90'
					: 'bg-amber-500 text-white hover:bg-amber-500/90 dark:bg-amber-600 dark:hover:bg-amber-600/90'
			)}
		>
			<Pencil className={cn('h-3 w-3', !isOpen && 'fill-current opacity-80')} />
			{label}
		</button>
	);
}
