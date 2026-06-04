import { useEffect, useRef, useState } from 'react';
import {
	ChevronLeft,
	ChevronRight,
	Plus,
	X,
	Pin,
	MessageSquare,
	Terminal as TerminalIcon,
} from 'lucide-react';
import { type PaneView } from '@/lib/panes/types';
import { CommandRow } from '@/components/ui/command-row';
import { FeedbackState } from '@/components/ui/feedback-state';
import { IconButton } from '@/components/ui/icon-button';
import { useDockStore, DOCK_MIN_WIDTH, DOCK_MAX_WIDTH } from './dock-store';
import { useDragState } from '@/lib/panes/drag-state';
import { usePaneStore } from '@/lib/panes/pane-store';
import { PaneBody, viewLabel } from '@/shell/panes/pane-views';
import { viewKey } from '@/shell/panes/view-key';
import { viewWorkspace } from '@/shell/panes/tab-workspace';
import { createTerminalSession } from '@/terminal/single-terminal';
import { mintThreadId } from '@/chat';
import { activeProjectCwd } from '@/lib/shell/active-project-cwd';
import { sessionEnsure } from '@/lib/tauri-cmd';
import { cn } from '@/components/ui/utils';

function newChatTab(): { kind: 'chat'; sessionId: string } {
	const threadId = mintThreadId();
	// Register the session row in Rust ahead of any send so the streaming
	// child can spawn on the first prompt. Fire-and-forget — sessionEnsure
	// is idempotent and the adapter also calls it on attach.
	void sessionEnsure(threadId, activeProjectCwd(), {}).catch((e) =>
		console.warn('sessionEnsure (dock):', e)
	);
	return { kind: 'chat', sessionId: threadId };
}

const COLLAPSED_WIDTH = '36px';

export function Dock() {
	const dockState = useDockStore((s) => s.state);
	const tabs = useDockStore((s) => s.tabs);
	const activeIdx = useDockStore((s) => s.activeIdx);
	const setState = useDockStore((s) => s.setState);
	const switchTab = useDockStore((s) => s.switchTab);
	const closeTab = useDockStore((s) => s.closeTab);
	const togglePinned = useDockStore((s) => s.togglePinned);
	const addTab = useDockStore((s) => s.addTab);
	const appendView = useDockStore((s) => s.appendView);
	const storedWidth = useDockStore((s) => s.width);
	const setStoredWidth = useDockStore((s) => s.setWidth);

	const drag = useDragState();
	const [dropHover, setDropHover] = useState(false);

	if (dockState === 'hidden') return null;

	const width = dockState === 'collapsed' ? COLLAPSED_WIDTH : `${storedWidth}px`;

	// Pane → dock: detach the source tab and append it as a dock tab. We use
	// moveTab to a sentinel pane id won't work, so instead we read the source
	// view directly off the pane store and explicitly closeTab there. Dock →
	// dock drops are no-ops for now (in-dock reordering is out of scope).
	function handleExternalDrop() {
		setDropHover(false);
		if (
			!drag.active ||
			drag.source !== 'pane' ||
			drag.srcLeafId == null ||
			drag.srcTabIdx == null
		) {
			drag.end();
			return;
		}
		const paneStore = usePaneStore.getState();
		const root = paneStore.root;
		const srcLeaf = findLeafShallow(root, drag.srcLeafId);
		if (!srcLeaf) {
			drag.end();
			return;
		}
		const view = srcLeaf.tabs[drag.srcTabIdx];
		if (!view) {
			drag.end();
			return;
		}
		// Append into dock first, then close from source pane.
		appendView(view);
		paneStore.closeTab(drag.srcLeafId, drag.srcTabIdx);
		drag.end();
	}

	if (dockState === 'collapsed') {
		return (
			<aside
				aria-label="Dock"
				className="flex h-full flex-col border-l py-3"
				style={{
					width,
					background: 'var(--bg-base)',
					borderColor: 'var(--border-soft)',
				}}
				onDragOver={(e) => {
					if (drag.active) {
						e.preventDefault();
						e.dataTransfer.dropEffect = 'move';
					}
				}}
				onDrop={handleExternalDrop}
			>
				<div className="flex flex-col items-center gap-1 px-1">
					{tabs.map((tab, idx) => {
						const ws = viewWorkspace(tab);
						const isActive = idx === activeIdx;
						const isPinned = Boolean(tab.pinned);
						return (
							<button
								key={`${idx}-${tab.kind}`}
								type="button"
								draggable={!isPinned}
								onDragStart={(e) => {
									if (isPinned) {
										e.preventDefault();
										return;
									}
									e.dataTransfer.effectAllowed = 'move';
									e.dataTransfer.setData('application/x-dock-tab', `${idx}`);
									useDragState.getState().startDock(idx);
								}}
								onDragEnd={() => useDragState.getState().end()}
								onClick={() => {
									switchTab(idx);
									setState('expanded');
								}}
								title={viewLabel(tab)}
								aria-label={viewLabel(tab)}
								className={cn(
									'relative grid h-7 w-7 place-items-center rounded-sm transition-colors',
									'hover:bg-card'
								)}
								style={{
									color: isActive ? `var(--tint-${ws}-fg)` : 'var(--fg-faint)',
								}}
							>
								{isActive && (
									<span
										aria-hidden="true"
										className="absolute -right-1 top-1.5 bottom-1.5 w-0.5 rounded-l"
										style={{ background: `var(--tint-${ws}-fg)` }}
									/>
								)}
								<DockTabIcon view={tab} />
							</button>
						);
					})}
					<button
						type="button"
						onClick={() => setState('expanded')}
						title="Expand dock"
						aria-label="Expand dock"
						className="grid h-7 w-7 place-items-center rounded-sm text-muted-foreground hover:bg-card"
					>
						<ChevronLeft className="h-3.5 w-3.5" />
					</button>
				</div>
			</aside>
		);
	}

	// expanded
	const activeTab = tabs[activeIdx];
	return (
		<aside
			aria-label="Dock"
			className="relative flex h-full flex-col border-l"
			style={{
				width,
				background: 'var(--bg-base)',
				borderColor: 'var(--border-soft)',
			}}
		>
			<DockResizeHandle width={storedWidth} setWidth={setStoredWidth} />
			<div
				className="flex shrink-0 items-stretch border-b"
				style={{
					height: 'var(--tab-h)',
					borderColor: 'var(--border-soft)',
					background: 'var(--bg-sunken)',
				}}
				onDragOver={(e) => {
					if (drag.active) {
						e.preventDefault();
						e.dataTransfer.dropEffect = 'move';
						setDropHover(true);
					}
				}}
				onDragLeave={() => setDropHover(false)}
				onDrop={handleExternalDrop}
			>
				<div
					className={cn(
						'ikenga-tab-strip flex flex-1 items-stretch gap-1 overflow-x-auto px-2',
						dropHover && 'bg-primary/10'
					)}
					data-tabstrip-mixed={tabs.length > 1 ? 'true' : 'false'}
				>
					{tabs.map((tab, idx) => {
						const ws = viewWorkspace(tab);
						const isActive = idx === activeIdx;
						const isPinned = Boolean(tab.pinned);
						return (
							<button
								key={`${idx}-${tab.kind}`}
								type="button"
								draggable={!isPinned}
								onDragStart={(e) => {
									if (isPinned) {
										e.preventDefault();
										return;
									}
									e.dataTransfer.effectAllowed = 'move';
									e.dataTransfer.setData('application/x-dock-tab', `${idx}`);
									useDragState.getState().startDock(idx);
								}}
								onDragEnd={() => useDragState.getState().end()}
								data-ws={ws}
								data-active={isActive ? 'true' : 'false'}
								onClick={() => switchTab(idx)}
								onAuxClick={(e) => {
									if (e.button === 1 && !isPinned) {
										e.preventDefault();
										closeTab(idx);
									}
								}}
								className={cn(
									'group relative flex shrink-0 items-center gap-2 px-3 text-xs',
									'transition-colors'
								)}
								style={{
									color: isActive ? 'var(--fg)' : 'var(--fg-faint)',
									background: isActive ? 'var(--bg-base)' : 'transparent',
								}}
								title={viewLabel(tab)}
							>
								<DockTabIcon view={tab} />
								<span className="truncate capitalize">{viewLabel(tab)}</span>
								{isPinned && <Pin className="h-2.5 w-2.5 -rotate-45" />}
								{!isPinned && (
									<span
										role="button"
										tabIndex={-1}
										aria-label="Close dock tab"
										onClick={(e) => {
											e.stopPropagation();
											closeTab(idx);
										}}
										className="grid h-3.5 w-3.5 place-items-center rounded-sm opacity-0 group-hover:opacity-100 hover:bg-card"
										onAuxClick={(e) => {
											e.stopPropagation();
											togglePinned(idx);
										}}
									>
										<X className="h-2.5 w-2.5" />
									</span>
								)}
							</button>
						);
					})}
				</div>
				<div
					className="flex shrink-0 items-center gap-1 border-l px-1"
					style={{ borderColor: 'var(--border-soft)' }}
				>
					<DockAddButton onAdd={addTab} />
					<IconButton
						onClick={() => setState('collapsed')}
						title="Collapse dock"
						aria-label="Collapse dock"
					>
						<ChevronRight className="h-3.5 w-3.5" />
					</IconButton>
				</div>
			</div>
			<div className="relative flex-1 overflow-hidden" style={{ background: 'var(--bg-base)' }}>
				{activeTab ? (
					<PaneBody key={viewKey(activeTab)} paneId="__dock__" view={activeTab} />
				) : (
					<DockEmpty
						onSeedChat={() => {
							appendView(newChatTab());
						}}
						onSeedTerminal={() => {
							appendView({ kind: 'terminal', sessionId: createTerminalSession() });
						}}
					/>
				)}
				<div
					aria-hidden="true"
					onDragEnter={(e) => {
						if (drag.active && drag.source === 'pane') e.preventDefault();
					}}
					onDragOver={(e) => {
						if (!drag.active || drag.source !== 'pane') return;
						e.preventDefault();
						e.dataTransfer.dropEffect = 'move';
						setDropHover(true);
					}}
					onDragLeave={() => setDropHover(false)}
					onDrop={handleExternalDrop}
					className={cn(
						'absolute inset-0 z-20 flex items-center justify-center border-2 border-dashed text-xs font-medium transition-colors',
						drag.active && drag.source === 'pane'
							? 'pointer-events-auto'
							: 'pointer-events-none opacity-0',
						dropHover
							? 'border-primary bg-primary/15 text-primary'
							: 'border-primary/40 bg-background/60 text-muted-foreground'
					)}
				>
					Drop to dock
				</div>
			</div>
		</aside>
	);
}

function DockResizeHandle({ width, setWidth }: { width: number; setWidth: (n: number) => void }) {
	const startRef = useRef<{ x: number; w: number } | null>(null);

	function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
		e.preventDefault();
		(e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
		startRef.current = { x: e.clientX, w: width };
		document.body.style.cursor = 'col-resize';
		document.body.style.userSelect = 'none';
	}

	function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
		if (!startRef.current) return;
		const dx = e.clientX - startRef.current.x;
		// Dock is on the right edge — dragging left grows it.
		const next = startRef.current.w - dx;
		setWidth(Math.max(DOCK_MIN_WIDTH, Math.min(DOCK_MAX_WIDTH, next)));
	}

	function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
		startRef.current = null;
		try {
			(e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
		} catch {
			// ignore
		}
		document.body.style.cursor = '';
		document.body.style.userSelect = '';
	}

	return (
		<div
			role="separator"
			aria-orientation="vertical"
			aria-label="Resize dock"
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerUp}
			onPointerCancel={onPointerUp}
			className="absolute left-0 top-0 z-10 h-full w-1 -translate-x-1/2 cursor-col-resize hover:bg-primary/30"
		/>
	);
}

function DockTabIcon({ view }: { view: PaneView }) {
	switch (view.kind) {
		case 'chat':
			return <MessageSquare className="h-3.5 w-3.5" />;
		case 'terminal':
			return <TerminalIcon className="h-3.5 w-3.5" />;
		default:
			return <span className="h-3.5 w-3.5" aria-hidden="true" />;
	}
}

function DockAddButton({ onAdd }: { onAdd: (view: PaneView) => void }) {
	const [open, setOpen] = useState(false);
	const btnRef = useRef<HTMLButtonElement | null>(null);
	const menuRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		if (!open) return;
		const onDown = (e: MouseEvent) => {
			const t = e.target as Node | null;
			if (t && !btnRef.current?.contains(t) && !menuRef.current?.contains(t)) {
				setOpen(false);
			}
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') setOpen(false);
		};
		window.addEventListener('mousedown', onDown);
		window.addEventListener('keydown', onKey);
		return () => {
			window.removeEventListener('mousedown', onDown);
			window.removeEventListener('keydown', onKey);
		};
	}, [open]);

	function pick(view: PaneView) {
		onAdd(view);
		setOpen(false);
	}

	return (
		<div className="relative">
			<IconButton
				ref={btnRef}
				onClick={() => setOpen((v) => !v)}
				title="New tab"
				aria-label="New tab"
				aria-haspopup="menu"
				aria-expanded={open}
			>
				<Plus className="h-3.5 w-3.5" />
			</IconButton>
			{open && (
				<div
					ref={menuRef}
					role="menu"
					className="absolute right-0 top-full z-50 mt-1 w-44 overflow-hidden rounded-md border border-border bg-popover py-1 text-popover-foreground shadow-lg"
				>
					<DockMenuItem Icon={MessageSquare} label="New chat" onClick={() => pick(newChatTab())} />
					<DockMenuItem
						Icon={TerminalIcon}
						label="New terminal"
						onClick={() => pick({ kind: 'terminal', sessionId: createTerminalSession() })}
					/>
					<DockMenuItem
						Icon={TerminalIcon}
						label="New Claude terminal"
						onClick={() =>
							pick({
								kind: 'terminal',
								sessionId: createTerminalSession({ cmd: ['claude'], title: 'claude' }),
							})
						}
					/>
				</div>
			)}
		</div>
	);
}

// Dock `+` menu rows share the consolidated `CommandRow` (size `sm`, rendered
// as a `<button role="menuitem">` for the `role="menu"` container). This gains
// the focus-visible ring the hand-rolled button lacked; the dropdown's keyboard
// roving-tabindex remains a known dock-level gap (see command-row.md §4).
function DockMenuItem({
	Icon,
	label,
	onClick,
}: {
	Icon: typeof Plus;
	label: string;
	onClick: () => void;
}) {
	return <CommandRow size="sm" as="menuitem" Icon={Icon} label={label} onSelect={onClick} />;
}

function DockEmpty({
	onSeedChat,
	onSeedTerminal,
}: {
	onSeedChat: () => void;
	onSeedTerminal: () => void;
}) {
	return (
		<FeedbackState
			variant="empty"
			fill
			heading="The dock is empty."
			body={
				<>
					Drag tabs in from any pane, or
					<br />
					seed a new session.
				</>
			}
			action={
				<>
					<button
						type="button"
						onClick={onSeedChat}
						className="rounded border px-3 py-1 text-xs hover:bg-card"
						style={{ borderColor: 'var(--border)' }}
					>
						New chat
					</button>
					<button
						type="button"
						onClick={onSeedTerminal}
						className="rounded border px-3 py-1 text-xs hover:bg-card"
						style={{ borderColor: 'var(--border)' }}
					>
						New terminal
					</button>
				</>
			}
		/>
	);
}

// Light helper — same shape as pane-reducer's findLeaf, kept inline so the
// dock doesn't import internal pane-store machinery directly.
function findLeafShallow(
	node: import('@/lib/panes/types').PaneNode,
	id: string
): import('@/lib/panes/types').LeafNode | null {
	if (node.type === 'leaf') return node.id === id ? node : null;
	for (const child of node.children) {
		const found = findLeafShallow(child, id);
		if (found) return found;
	}
	return null;
}
