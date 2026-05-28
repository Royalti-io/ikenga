// Pkg sidebar — renders the runtime menu published by a pkg iframe via
// `host.pkg.setMenu`. Active when the focused pane is on a `/pkg/<id>/...`
// route. Clicks update the pkg-menu-store's active feature, which the
// pkg-iframe-host re-emits as a hostContext change so the iframe can swap
// its mounted view.

import {
	Activity,
	AlertTriangle,
	CalendarDays,
	CheckCheck,
	Folder,
	FolderKanban,
	LayoutDashboard,
	ListChecks,
	Mail,
	Package,
	Pencil,
	Send,
	Sun,
	TrendingUp,
	type LucideIcon,
} from 'lucide-react';

import { cn } from '@/components/ui/utils';
import { usePkgMenuStore, type PkgMenuItem } from '@/lib/pkg/pkg-menu-store';

// Stable empty-array sentinel — used by the menu selector when no menu has
// been published for this pkg yet. Without this, `?? []` returns a fresh
// array every render, Zustand sees a referential change, and the
// "getSnapshot should be cached" guard triggers a re-render loop.
const EMPTY_ITEMS: readonly PkgMenuItem[] = [];

const ICONS: Record<string, LucideIcon> = {
	'layout-dashboard': LayoutDashboard,
	'list-checks': ListChecks,
	'trending-up': TrendingUp,
	send: Send,
	mail: Mail,
	folder: Folder,
	'folder-kanban': FolderKanban,
	pencil: Pencil,
	package: Package,
	activity: Activity,
	'alert-triangle': AlertTriangle,
	'calendar-days': CalendarDays,
	'check-check': CheckCheck,
	sun: Sun,
};

function iconFor(name: string | null | undefined): LucideIcon {
	if (name && name in ICONS) return ICONS[name]!;
	return Package;
}

export function PkgMode({ pkgId }: { pkgId: string }) {
	const items = usePkgMenuStore((s) => s.menus[pkgId] ?? EMPTY_ITEMS);
	const activeFeature = usePkgMenuStore((s) => s.activeFeatures[pkgId]);
	const setActiveFeature = usePkgMenuStore((s) => s.setActiveFeature);

	if (items.length === 0) {
		return (
			<div className="h-full overflow-y-auto py-3 px-4 text-xs text-muted-foreground">
				Waiting for pkg menu…
			</div>
		);
	}

	// Group items by `section`. Adjacent items sharing the same section render
	// together under one heading; items with no section (or `null`) form the
	// implicit first group. Order is preserved as published.
	const groups: { section: string | null; items: PkgMenuItem[] }[] = [];
	for (const it of items) {
		const section = it.section ?? null;
		const last = groups[groups.length - 1];
		if (last && last.section === section) last.items.push(it);
		else groups.push({ section, items: [it] });
	}

	return (
		<div className="h-full overflow-y-auto py-2">
			{groups.map((g, gi) => (
				<div
					key={g.section ?? `__implicit_${gi}`}
					className={cn(gi > 0 && 'mt-3 border-t border-border/40 pt-3')}
				>
					{g.section && (
						<div className="px-4 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
							{g.section}
						</div>
					)}
					<ul className="flex flex-col">
						{g.items.map((item) => {
							const Icon = iconFor(item.icon);
							// Pkg-driven `active` wins; otherwise fall back to the
							// store's last-clicked feature. Disabled items never
							// highlight and never fire a click.
							const isActive = item.disabled
								? false
								: (item.active ?? item.id === activeFeature);
							return (
								<li key={item.id}>
									<button
										type="button"
										disabled={item.disabled}
										aria-disabled={item.disabled}
										onClick={
											item.disabled ? undefined : () => setActiveFeature(pkgId, item.id)
										}
										className={cn(
											'flex w-full items-center gap-3 px-4 py-1.5 text-left text-sm transition-colors',
											'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
											isActive && 'bg-accent text-accent-foreground font-medium',
											item.disabled && 'pointer-events-none opacity-40 hover:bg-transparent'
										)}
									>
										<Icon className="h-4 w-4 shrink-0" />
										<span className="flex-1 truncate">{item.label}</span>
										{item.badge != null && item.badge !== '' && (
											<span className="ml-auto rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium">
												{item.badge}
											</span>
										)}
									</button>
								</li>
							);
						})}
					</ul>
				</div>
			))}
		</div>
	);
}

/** Convenience: read the pkg ID from a route path. Returns null if not a pkg
 *  route. Re-exported here so AppMode doesn't need to import the store
 *  internals just to branch. */
export function pkgIdFromRoute(route: string | null | undefined): string | null {
	if (!route) return null;
	const m = route.match(/^\/pkg\/([^/]+)/);
	return m ? m[1]! : null;
}

export type { PkgMenuItem };
