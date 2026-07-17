import { useCallback } from 'react';
import type { LeafNode } from '@/lib/panes/types';
import { hasAddressBar } from '@/lib/panes/pane-address';
import { usePaneStore } from '@/lib/panes/pane-store';
import { PaneAddressBar } from './pane-address-bar';
import { PaneIykeOverlay } from './pane-iyke-overlay';
import { PaneTabStrip } from './pane-tab-strip';
import { PaneToolbar } from './pane-toolbar';
import { PaneBody } from './pane-views';
import { tabUid } from './view-key';
import { PaneDropZones } from './drop-zones';
import { cn } from '@/components/ui/utils';

interface PaneProps {
	leaf: LeafNode;
}

export function Pane({ leaf }: PaneProps) {
	// Subscribe to a *boolean* derived from focusedId, not focusedId itself.
	// Otherwise every focus change re-renders every pane in the tree; with
	// the boolean selector each pane only re-renders when its own focused
	// state flips (twice per focus change cluster: old + new).
	const isFocused = usePaneStore((s) => s.focusedId === leaf.id);
	const focusPane = usePaneStore((s) => s.focusPane);
	const refreshTick = usePaneStore((s) => s.refreshTicks[leaf.id] ?? 0);
	const activeTab = leaf.tabs[leaf.activeTabIdx];

	// Capture-phase focus: any click anywhere in the pane focuses it. Stops
	// short of stealing keyboard focus from the user's actual click target.
	const handleFocusCapture = useCallback(() => {
		if (!isFocused) focusPane(leaf.id);
	}, [isFocused, focusPane, leaf.id]);

	return (
		<div
			onMouseDownCapture={handleFocusCapture}
			onFocusCapture={handleFocusCapture}
			className={cn(
				'flex h-full w-full flex-col overflow-hidden',
				'bg-background',
				'ring-inset transition-shadow',
				isFocused ? 'ring-1' : 'ring-0'
			)}
			style={
				isFocused
					? {
							['--tw-ring-color' as string]:
								'color-mix(in srgb, var(--tint-fg-active, var(--primary)) 40%, transparent)',
						}
					: undefined
			}
			data-pane-id={leaf.id}
			data-focused={isFocused ? 'true' : 'false'}
		>
			<div className="flex shrink-0 items-stretch border-b border-border">
				<div className="flex-1 min-w-0">
					<PaneTabStrip leaf={leaf} isFocused={isFocused} />
				</div>
				<div className="flex shrink-0 items-center px-1.5">
					<PaneToolbar paneId={leaf.id} />
				</div>
			</div>
			{activeTab && hasAddressBar(activeTab) && (
				<PaneAddressBar paneId={leaf.id} view={activeTab} />
			)}
			<div className="relative flex-1 min-h-0 overflow-hidden">
				{activeTab && (
					<PaneBody
						// Keyed by the tab's own stable identity (not activeTabIdx, a
						// POSITION) so dragging the active tab or closing a
						// lower-indexed sibling doesn't shift this index and force a
						// spurious remount of a view the user only moved. refreshTick
						// stays in the key — an explicit refresh must still remount.
						key={`${leaf.id}:${tabUid(activeTab)}:${refreshTick}`}
						paneId={leaf.id}
						view={activeTab}
					/>
				)}
				<PaneDropZones paneId={leaf.id} />
				<PaneIykeOverlay paneId={leaf.id} />
			</div>
		</div>
	);
}
