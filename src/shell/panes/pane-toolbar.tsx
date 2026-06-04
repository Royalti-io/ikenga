import { RefreshCw, SplitSquareHorizontal, SplitSquareVertical, X } from 'lucide-react';
import type { PaneId } from '@/lib/panes/types';
import { usePaneStore } from '@/lib/panes/pane-store';
import { IconButton } from '@/components/ui/icon-button';

interface PaneToolbarProps {
	paneId: PaneId;
}

export function PaneToolbar({ paneId }: PaneToolbarProps) {
	const splitPane = usePaneStore((s) => s.splitPane);
	const closePane = usePaneStore((s) => s.closePane);
	const refreshPane = usePaneStore((s) => s.refreshPane);
	const canSplit = usePaneStore((s) => s.canSplit());
	const leafCount = usePaneStore((s) => s.leafCount());

	const splitDisabled = !canSplit;
	const splitTitle = splitDisabled ? 'Max 6 panes' : undefined;
	const closeDisabled = leafCount <= 1;

	return (
		<div className="flex items-center gap-0.5">
			<IconButton
				onClick={() => refreshPane(paneId)}
				title="Refresh pane content"
				aria-label="Refresh pane"
			>
				<RefreshCw className="h-3.5 w-3.5" />
			</IconButton>
			<IconButton
				onClick={() => splitPane(paneId, 'horizontal')}
				disabled={splitDisabled}
				title={splitTitle ?? 'Split right (⌘\\)'}
				aria-label="Split right"
			>
				<SplitSquareHorizontal className="h-3.5 w-3.5" />
			</IconButton>
			<IconButton
				onClick={() => splitPane(paneId, 'vertical')}
				disabled={splitDisabled}
				title={splitTitle ?? 'Split down (⌘⇧\\)'}
				aria-label="Split down"
			>
				<SplitSquareVertical className="h-3.5 w-3.5" />
			</IconButton>
			<IconButton
				onClick={() => closePane(paneId)}
				disabled={closeDisabled}
				title={closeDisabled ? 'Cannot close last pane' : 'Close pane'}
				aria-label="Close pane"
			>
				<X className="h-3.5 w-3.5" />
			</IconButton>
		</div>
	);
}
