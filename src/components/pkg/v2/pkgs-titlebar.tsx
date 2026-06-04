// Title strip for the unified pkg surface. Houses the title + status meta,
// an optional search input (the filter pill row has been folded into the
// Packages-mode sidebar), and the primary [Install pkg] action.

import { Plus, Search, Settings } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { DerivedPkgs } from '@/lib/pkgs/use-derived';

export function PkgsTitlebar({
	d,
	onInstallPkg,
	onOpenSettings,
	query,
	onQueryChange,
}: {
	d: DerivedPkgs;
	onInstallPkg: () => void;
	onOpenSettings?: () => void;
	/** Free-text search across the visible rows. */
	query?: string;
	onQueryChange?: (q: string) => void;
}) {
	return (
		<div className="flex items-center gap-3 border-b border-border bg-muted/30 px-6 py-3">
			<h2 className="font-display text-xl font-medium leading-none tracking-tight">Packages</h2>
			<span className="font-mono text-[10.5px] uppercase leading-none tracking-wider text-muted-foreground/70">
				{d.installed.length} installed · kernel api v1 · {d.sidecarsRunning} sidecar
				{d.sidecarsRunning === 1 ? '' : 's'} running
			</span>
			<span className="flex-1" />
			{onQueryChange && (
				<div className="relative w-64">
					<Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
					<input
						value={query ?? ''}
						onChange={(e) => onQueryChange(e.target.value)}
						placeholder="Filter by name, id, route…"
						aria-label="Filter packages by name, id, or route"
						className="h-7 w-full rounded-sm border border-border bg-background pl-8 pr-2 text-sm outline-none focus:border-primary"
					/>
				</div>
			)}
			{onOpenSettings && (
				<Button size="sm" variant="ghost" className="h-8 gap-1.5" onClick={onOpenSettings}>
					<Settings className="h-3.5 w-3.5" />
					Settings
				</Button>
			)}
			<Button size="sm" className="h-8 gap-1.5" onClick={onInstallPkg}>
				<Plus className="h-3.5 w-3.5" />
				Install pkg
			</Button>
		</div>
	);
}
