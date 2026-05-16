// Studio right rail — Chat / Code / DOM / Manifest tab strip.
//
// Loupe density renders all four tabs. Grid density renders Chat only.
// Compare density renders Chat only (per the unified plan §"Right rail
// tabs" — Code/DOM/Manifest require a single focused artifact, which
// compare doesn't have).
//
// This component is purely presentational: the parent owns the slot
// content and decides which tabs are visible.

import { useMemo, useState, type ReactNode } from 'react';
import { Code as CodeIcon, MessageSquare, Settings as ManifestIcon, TreePine } from 'lucide-react';
import { cn } from '@/components/ui/utils';

export type RightRailTab = 'chat' | 'code' | 'dom' | 'manifest';

const TAB_GLYPHS: Record<RightRailTab, ReactNode> = {
	chat: <MessageSquare className="h-3 w-3" />,
	code: <CodeIcon className="h-3 w-3" />,
	dom: <TreePine className="h-3 w-3" />,
	manifest: <ManifestIcon className="h-3 w-3" />,
};

const TAB_LABELS: Record<RightRailTab, string> = {
	chat: 'Chat',
	code: 'Code',
	dom: 'DOM',
	manifest: 'Manifest',
};

export interface RightRailSlots {
	chat: ReactNode;
	code?: ReactNode;
	dom?: ReactNode;
	manifest?: ReactNode;
}

interface RightRailProps {
	tab: RightRailTab;
	onChangeTab: (tab: RightRailTab) => void;
	slots: RightRailSlots;
}

export function RightRail({ tab, onChangeTab, slots }: RightRailProps) {
	const visible = useMemo<RightRailTab[]>(() => {
		const out: RightRailTab[] = ['chat'];
		if (slots.code !== undefined) out.push('code');
		if (slots.dom !== undefined) out.push('dom');
		if (slots.manifest !== undefined) out.push('manifest');
		return out;
	}, [slots.code, slots.dom, slots.manifest]);

	// Defensive: if the active tab was hidden by a density change, snap to
	// Chat so we don't render an undefined slot.
	const active: RightRailTab = visible.includes(tab) ? tab : 'chat';
	const slot =
		active === 'chat'
			? slots.chat
			: active === 'code'
				? slots.code
				: active === 'dom'
					? slots.dom
					: slots.manifest;

	return (
		<div className="flex h-full min-h-0 flex-col border-l border-border bg-background">
			<div
				role="tablist"
				className="flex shrink-0 items-stretch border-b border-border bg-muted/20"
			>
				{visible.map((t) => (
					<RailTabButton
						key={t}
						active={active === t}
						onClick={() => onChangeTab(t)}
						icon={TAB_GLYPHS[t]}
						label={TAB_LABELS[t]}
					/>
				))}
			</div>
			<div className="flex-1 min-h-0 overflow-hidden">{slot}</div>
		</div>
	);
}

interface RailTabButtonProps {
	active: boolean;
	onClick: () => void;
	icon: ReactNode;
	label: string;
}

function RailTabButton({ active, onClick, icon, label }: RailTabButtonProps) {
	return (
		<button
			type="button"
			role="tab"
			aria-selected={active}
			onClick={onClick}
			className={cn(
				'flex items-center gap-1.5 border-r border-border px-3 py-2 text-[10px] uppercase tracking-wider transition-colors',
				active
					? 'border-b-2 border-b-amber-600 bg-background text-foreground dark:border-b-amber-400'
					: 'border-b-2 border-b-transparent text-muted-foreground hover:bg-muted/30 hover:text-foreground'
			)}
		>
			{icon}
			<span className="font-mono">{label}</span>
		</button>
	);
}

/** Tab-state hook. Plain local state today; placeholder for future
 *  per-folder persistence without disturbing callers. */
export function useRightRailTab(initial: RightRailTab = 'chat') {
	return useState<RightRailTab>(initial);
}
