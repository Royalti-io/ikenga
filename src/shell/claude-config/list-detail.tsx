import type { ReactNode } from 'react';

import { cn } from '@/components/ui/utils';

export function FrontmatterGrid({ entries }: { entries: Array<[string, ReactNode]> }) {
	return (
		<div className="ccfg-fm-grid">
			{entries.map(([k, v]) => (
				<RowFm key={k} k={k} v={v} />
			))}
		</div>
	);
}

function RowFm({ k, v }: { k: string; v: ReactNode }) {
	return (
		<>
			<span className="ccfg-fm-key">{k}</span>
			<span className="ccfg-fm-val">{v}</span>
		</>
	);
}

interface ChipsProps {
	values: readonly string[];
	variant?: 'tool' | 'skill' | 'mcp' | 'event' | 'default';
	/** Show the first N chips and collapse the rest under a "+ N more" expander. */
	initial?: number;
}

export function Chips({ values, variant = 'default', initial }: ChipsProps) {
	const limit = initial ?? values.length;
	const visible = values.slice(0, limit);
	const hidden = values.length - visible.length;
	const cls = variant === 'default' ? '' : `is-${variant}`;
	return (
		<div className="ccfg-chips">
			{visible.map((v) => (
				<span key={v} className={cn('ccfg-chip', cls)}>
					{v}
				</span>
			))}
			{hidden > 0 && <span className="ccfg-chip is-more">+ {hidden} more</span>}
		</div>
	);
}
