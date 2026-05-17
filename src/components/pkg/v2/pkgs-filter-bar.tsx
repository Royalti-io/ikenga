// Filter pills + search for the unified pkg surface.

import { Search } from 'lucide-react';
import { cn } from '@/components/ui/utils';
import type { DerivedPkgs } from '@/lib/pkgs/use-derived';

export type FilterKey = 'all' | 'installed' | 'updates' | 'store' | 'review' | 'disabled';

export interface FilterDef {
	id: FilterKey;
	label: string;
	count: number;
	tone?: 'attention' | 'warn';
}

export function filtersFor(d: DerivedPkgs): FilterDef[] {
	return [
		{ id: 'all', label: 'All', count: d.rows.length },
		{ id: 'installed', label: 'Installed', count: d.installed.length },
		{ id: 'updates', label: 'Updates', count: d.updates.length, tone: 'attention' },
		{ id: 'store', label: 'Store', count: d.registry.length },
		{
			id: 'review',
			label: 'Needs review',
			count: d.trust.length + d.violations.length,
			tone: 'warn',
		},
		{
			id: 'disabled',
			label: 'Disabled',
			count: d.installed.filter((r) => !r.enabled).length,
		},
	];
}

export function PkgsFilterBar({
	d,
	active,
	onChange,
	query,
	onQueryChange,
}: {
	d: DerivedPkgs;
	active: FilterKey;
	onChange: (id: FilterKey) => void;
	query: string;
	onQueryChange: (q: string) => void;
}) {
	const filters = filtersFor(d);
	return (
		<div className="flex items-center gap-1 overflow-x-auto border-b border-border bg-muted/30 px-6 py-2.5">
			{filters.map((f) => (
				<button
					key={f.id}
					type="button"
					onClick={() => onChange(f.id)}
					className={cn(
						'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm font-medium transition-colors',
						active === f.id
							? 'border-border bg-card text-foreground'
							: 'border-transparent text-muted-foreground hover:bg-accent hover:text-foreground'
					)}
				>
					<span>{f.label}</span>
					<span
						className={cn(
							'rounded-sm border px-1.5 py-px font-mono text-[10.5px]',
							f.tone === 'attention' && (active === f.id || f.count > 0)
								? 'border-amber-500/40 bg-amber-500/15 text-amber-500'
								: f.tone === 'warn' && (active === f.id || f.count > 0)
									? 'border-red-500/40 bg-red-500/15 text-red-500'
									: 'border-border bg-background text-muted-foreground'
						)}
					>
						{f.count}
					</span>
				</button>
			))}
			<span className="flex-1" />
			<div className="relative w-64">
				<Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
				<input
					value={query}
					onChange={(e) => onQueryChange(e.target.value)}
					placeholder="Filter pkgs by name, id, route…"
					className="h-7 w-full rounded-sm border border-border bg-background pl-8 pr-2 text-sm outline-none focus:border-primary"
				/>
			</div>
		</div>
	);
}
