// Title strip for the unified pkg surface.

import { Plus, Settings } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { DerivedPkgs } from '@/lib/pkgs/use-derived';

export function PkgsTitlebar({
	d,
	onInstallPkg,
	onOpenSettings,
}: {
	d: DerivedPkgs;
	onInstallPkg: () => void;
	onOpenSettings?: () => void;
}) {
	return (
		<div className="flex items-baseline gap-3 border-b border-border bg-muted/30 px-6 py-3">
			<h2 className="font-display text-xl font-medium tracking-tight">Packages</h2>
			<span className="font-mono text-[10.5px] uppercase tracking-wider text-muted-foreground/70">
				{d.installed.length} installed · kernel api v1 · {d.sidecarsRunning} sidecar
				{d.sidecarsRunning === 1 ? '' : 's'} running
			</span>
			<span className="flex-1" />
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
