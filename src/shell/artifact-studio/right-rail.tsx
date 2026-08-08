// Studio right rail — Terminal / Code / DOM / Manifest tab strip.
//
// Loupe density renders all four tabs. Grid density has no right rail.
// Compare density has no right rail (per the unified plan §"Right rail
// tabs" — Code/DOM/Manifest require a single focused artifact, which
// compare doesn't have).
//
// The Terminal slot is always the embedded PTY (or a picker when no
// terminal is attached). Agent and shell share the same rail slot, one
// mode at a time.
//
// This component is purely presentational: the parent owns the slot
// content and decides which tabs are visible.

import { useMemo, useState, type ReactNode } from 'react';
import {
	Code as CodeIcon,
	Settings as ManifestIcon,
	Terminal as TerminalIcon,
	TreePine,
} from 'lucide-react';
import { TabStrip, Tab } from '@/components/ui/tab-strip';

export type RightRailTab = 'terminal' | 'code' | 'dom' | 'manifest';

const TAB_GLYPHS: Record<RightRailTab, ReactNode> = {
	terminal: <TerminalIcon className="h-3 w-3" />,
	code: <CodeIcon className="h-3 w-3" />,
	dom: <TreePine className="h-3 w-3" />,
	manifest: <ManifestIcon className="h-3 w-3" />,
};

const TAB_LABELS: Record<RightRailTab, string> = {
	terminal: 'Terminal',
	code: 'Code',
	dom: 'DOM',
	manifest: 'Manifest',
};

export interface RightRailSlots {
	terminal: ReactNode;
	code?: ReactNode;
	dom?: ReactNode;
	manifest?: ReactNode;
}

interface RightRailProps {
	tab: RightRailTab;
	onChangeTab: (tab: RightRailTab) => void;
	slots: RightRailSlots;
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
		const out: RightRailTab[] = ['terminal'];
		if (slots.code !== undefined) out.push('code');
		if (slots.dom !== undefined) out.push('dom');
		if (slots.manifest !== undefined) out.push('manifest');
		return out;
	}, [slots.code, slots.dom, slots.manifest]);

	// Defensive: if the active tab was hidden by a density change, snap to
	// Terminal so we don't render an undefined slot.
	const active: RightRailTab = visible.includes(tab) ? tab : 'terminal';
	const slot =
		active === 'terminal'
			? slots.terminal
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
export function useRightRailTab(initial: RightRailTab = 'terminal') {
	return useState<RightRailTab>(initial);
}
