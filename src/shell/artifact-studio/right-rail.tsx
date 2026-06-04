// Studio right rail — Chat / Code / DOM / Manifest tab strip.
//
// Loupe density renders all four tabs. Grid density renders Chat only.
// Compare density renders Chat only (per the unified plan §"Right rail
// tabs" — Code/DOM/Manifest require a single focused artifact, which
// compare doesn't have).
//
// The Chat slot is dual-purpose: when an embedded terminal is attached
// to the Studio pane, the loupe swaps its body to the SingleTerminal
// host and relabels the tab to "Terminal" via `tabLabelOverrides` /
// `tabGlyphOverrides`. There is no separate Terminal tab — agent and
// shell share the same rail slot, one mode at a time.
//
// This component is purely presentational: the parent owns the slot
// content and decides which tabs are visible.

import { useMemo, useState, type ReactNode } from 'react';
import { Code as CodeIcon, MessageSquare, Settings as ManifestIcon, TreePine } from 'lucide-react';
import { TabStrip, Tab } from '@/components/ui/tab-strip';

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
	/** Per-tab label override. Used by the loupe to relabel the chat tab
	 *  to "Terminal" when an embedded PTY is attached, since the slot
	 *  body switches accordingly. */
	tabLabelOverrides?: Partial<Record<RightRailTab, string>>;
	tabGlyphOverrides?: Partial<Record<RightRailTab, ReactNode>>;
}

export function RightRail({
	tab,
	onChangeTab,
	slots,
	tabLabelOverrides,
	tabGlyphOverrides,
}: RightRailProps) {
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

	const labelFor = (t: RightRailTab) => tabLabelOverrides?.[t] ?? TAB_LABELS[t];
	const glyphFor = (t: RightRailTab) => tabGlyphOverrides?.[t] ?? TAB_GLYPHS[t];

	return (
		<div className="flex h-full min-h-0 flex-col border-l border-border bg-background">
			<TabStrip
				label="Studio views"
				className="shrink-0 border-b border-border bg-muted/20"
				activeIdx={visible.indexOf(active)}
				count={visible.length}
				onSwitch={(i) => onChangeTab(visible[i])}
			>
				{visible.map((t, i) => (
					<Tab
						key={t}
						index={i}
						active={active === t}
						label={labelFor(t)}
						glyph={glyphFor(t)}
						variant="rail"
						className="border-r border-border px-3 py-2"
						onActivate={() => onChangeTab(t)}
					/>
				))}
			</TabStrip>
			<div className="flex-1 min-h-0 overflow-hidden">{slot}</div>
		</div>
	);
}

/** Tab-state hook. Plain local state today; placeholder for future
 *  per-folder persistence without disturbing callers. */
export function useRightRailTab(initial: RightRailTab = 'chat') {
	return useState<RightRailTab>(initial);
}
