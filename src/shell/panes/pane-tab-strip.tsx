import { useMemo, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import type { LeafNode } from '@/lib/panes/types';
import { usePaneStore } from '@/lib/panes/pane-store';
import { useDragState } from '@/lib/panes/drag-state';
import { TabStrip, Tab } from '@/components/ui/tab-strip';
import { viewLabel, viewSubtitle } from './pane-views';
import { viewWorkspace } from './tab-workspace';
import { NewTabMenu, useAnchorRect } from './new-tab-menu';
import { cn } from '@/components/ui/utils';

interface PaneTabStripProps {
	leaf: LeafNode;
	isFocused: boolean;
}

export function PaneTabStrip({ leaf, isFocused }: PaneTabStripProps) {
	const switchTab = usePaneStore((s) => s.switchTab);
	const closeTab = usePaneStore((s) => s.closeTab);
	const focusPane = usePaneStore((s) => s.focusPane);
	const toggleTabPinned = usePaneStore((s) => s.toggleTabPinned);
	const reorderTab = usePaneStore((s) => s.reorderTab);

	const [menuOpen, setMenuOpen] = useState(false);
	const addBtnRef = useRef<HTMLButtonElement | null>(null);
	const anchor = useAnchorRect(menuOpen, addBtnRef);

	// Drop indicator for in-strip reorder: { idx, side }. `side='before'`
	// means the drop will insert *before* tab idx; `'after'` means after.
	const [dropAt, setDropAt] = useState<{ idx: number; side: 'before' | 'after' } | null>(null);

	// Per `<workspace>/design/shell/concepts/_shared/shell.css` §"Workspace tint on tabs":
	// single-workspace strips suppress inactive hairlines (the pane focus accent
	// already announces the workspace). Mixed strips opt in to the per-tab tint
	// hairline so inactive tabs each show their own workspace at low alpha.
	const isMixedWorkspace = useMemo(() => {
		if (leaf.tabs.length < 2) return false;
		const ws = leaf.tabs.map(viewWorkspace);
		return ws.some((w) => w !== ws[0]);
	}, [leaf.tabs]);

	function activate(idx: number) {
		focusPane(leaf.id);
		switchTab(leaf.id, idx);
	}

	function handleAddClick() {
		focusPane(leaf.id);
		setMenuOpen((v) => !v);
	}

	return (
		<div
			className={cn(
				'flex h-8 shrink-0 items-stretch border-b border-border bg-card',
				isFocused ? 'opacity-100' : 'opacity-80'
			)}
		>
			<TabStrip
				label="Open tabs"
				className="flex-1"
				activeIdx={leaf.activeTabIdx}
				count={leaf.tabs.length}
				onSwitch={activate}
				onReorder={(from, to) => reorderTab(leaf.id, from, to)}
				mixed={isMixedWorkspace}
			>
				{leaf.tabs.map((tab, idx) => {
					const isActive = idx === leaf.activeTabIdx;
					const isPinned = Boolean(tab.pinned);
					const ws = viewWorkspace(tab);
					return (
						<Tab
							key={`${idx}-${tab.kind}`}
							index={idx}
							active={isActive}
							ws={ws}
							label={viewLabel(tab)}
							labelClassName="capitalize"
							title={`${viewLabel(tab)}${isPinned ? ' (pinned)' : ''}\n${viewSubtitle(tab)}`}
							pinned={isPinned}
							closable={!isPinned}
							onActivate={() => activate(idx)}
							onClose={() => closeTab(leaf.id, idx)}
							onTogglePin={() => toggleTabPinned(leaf.id, idx)}
							onMiddleClick={!isPinned ? () => closeTab(leaf.id, idx) : undefined}
							draggable={!isPinned}
							dropEdge={dropAt?.idx === idx ? dropAt.side : null}
							className={cn(
								'border-r border-border',
								isPinned ? 'min-w-[32px] max-w-[140px] px-2' : 'min-w-[120px] max-w-[180px] px-3'
							)}
							dragHandlers={{
								onDragStart: (e) => {
									if (isPinned) {
										e.preventDefault();
										return;
									}
									e.dataTransfer.effectAllowed = 'move';
									// Some browsers cancel the drag unless dataTransfer carries
									// data — the real payload lives in useDragState.
									e.dataTransfer.setData('application/x-pane-tab', `${leaf.id}:${idx}`);
									useDragState.getState().startPane(leaf.id, idx);
								},
								onDragEnd: () => {
									useDragState.getState().end();
									setDropAt(null);
								},
								onDragOver: (e) => {
									const drag = useDragState.getState();
									if (drag.source !== 'pane' || drag.srcLeafId !== leaf.id) return;
									if (drag.srcTabIdx === idx) return;
									e.preventDefault();
									e.dataTransfer.dropEffect = 'move';
									const rect = e.currentTarget.getBoundingClientRect();
									const side = e.clientX < rect.left + rect.width / 2 ? 'before' : 'after';
									setDropAt((prev) =>
										prev && prev.idx === idx && prev.side === side ? prev : { idx, side }
									);
								},
								onDragLeave: (e) => {
									// Only clear when leaving the tab entirely, not on child enter.
									if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
									setDropAt((prev) => (prev?.idx === idx ? null : prev));
								},
								onDrop: (e) => {
									const drag = useDragState.getState();
									if (drag.source !== 'pane' || drag.srcLeafId !== leaf.id) return;
									if (drag.srcTabIdx === null || drag.srcTabIdx === idx) {
										setDropAt(null);
										return;
									}
									e.preventDefault();
									e.stopPropagation();
									const rect = e.currentTarget.getBoundingClientRect();
									const side = e.clientX < rect.left + rect.width / 2 ? 'before' : 'after';
									const from = drag.srcTabIdx;
									// Compute destination index in the *current* tabs array.
									let to = side === 'before' ? idx : idx + 1;
									if (from < to) to -= 1;
									reorderTab(leaf.id, from, to);
									setDropAt(null);
									drag.end();
								},
							}}
						/>
					);
				})}
			</TabStrip>
			<button
				ref={addBtnRef}
				type="button"
				onClick={(e) => {
					e.stopPropagation();
					handleAddClick();
				}}
				title="New tab in pane"
				aria-label="New tab"
				aria-expanded={menuOpen}
				className="flex h-full w-8 items-center justify-center text-muted-foreground hover:bg-accent hover:text-accent-foreground"
			>
				<Plus className="h-3.5 w-3.5" />
			</button>
			<NewTabMenu leaf={leaf} open={menuOpen} onClose={() => setMenuOpen(false)} anchor={anchor} />
		</div>
	);
}
