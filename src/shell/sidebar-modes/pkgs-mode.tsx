// Packages-mode sidebar. Activated by the activity-bar Packages icon (⌘4).
// Mirrors the filter pills inside <PkgsSurface /> as deep-link items so the
// user can jump straight to a focused subset (Updates / Trust / Store / …)
// without first landing on the All view.
//
// Counts are surfaced as live badges next to each item — they come from the
// same `usePkgsDerived` hook the surface itself uses, so the sidebar stays
// in sync without an additional kernel query.

import { Activity, ArrowUp, Ban, Box, Info, LayoutGrid, Package, PackageCheck, PackagePlus, PowerOff, Shield, type LucideIcon } from 'lucide-react';

import { cn } from '@/components/ui/utils';
import { findLeaf } from '@/lib/panes/pane-reducer';
import { usePaneStore } from '@/lib/panes/pane-store';
import { usePkgsDerived } from '@/lib/pkgs/use-derived';
import { useUpdater } from '@/lib/updater/use-updater';

type FilterKey = 'all' | 'installed' | 'updates' | 'store' | 'review' | 'disabled';

interface NavItem {
	to: string;
	filter?: FilterKey;
	label: string;
	Icon: LucideIcon;
	count?: number;
	tone?: 'attention' | 'warn';
}

interface NavSection {
	label: string;
	items: NavItem[];
}

export function PkgsMode() {
	const d = usePkgsDerived();
	const updater = useUpdater({ autoPoll: false });
	const navigateFocused = usePaneStore((s) => s.navigateFocused);

	// Track both the path and the current filter param so an active item
	// highlights correctly when the user is on a deep-linked view.
	const active = usePaneStore((s) => {
		const leaf = findLeaf(s.root, s.focusedId);
		if (!leaf) return { path: null as string | null, filter: null as string | null };
		const tab = leaf.tabs[leaf.activeTabIdx];
		if (!tab || tab.kind !== 'route') return { path: null, filter: null };
		const url = tab.path;
		const [path, qs] = url.split('?');
		const search = new URLSearchParams(qs ?? '');
		return { path, filter: search.get('filter') };
	});

	const disabledCount = d.installed.filter((p) => !p.enabled).length;
	const reviewCount = d.trust.length + d.violations.length;
	const shellUpdateCount = updater.available ? 1 : 0;

	const NAV: NavSection[] = [
		{
			label: 'Catalog',
			items: [
				{ to: '/packages', filter: 'all', label: 'All packages', Icon: LayoutGrid, count: d.rows.length },
				{ to: '/packages', filter: 'installed', label: 'Installed', Icon: PackageCheck, count: d.installed.length },
				{ to: '/packages', filter: 'store', label: 'Store', Icon: Package, count: d.registry.length },
			],
		},
		{
			label: 'Attention',
			items: [
				{
					to: '/packages',
					filter: 'updates',
					label: 'Updates available',
					Icon: ArrowUp,
					count: d.updates.length,
					tone: d.updates.length ? 'attention' : undefined,
				},
				{
					to: '/packages',
					filter: 'review',
					label: 'Needs review',
					Icon: Shield,
					count: reviewCount,
					tone: reviewCount ? 'warn' : undefined,
				},
				{
					to: '/packages',
					filter: 'review',
					label: 'Violations',
					Icon: Ban,
					count: d.violations.length,
					tone: d.violations.length ? 'warn' : undefined,
				},
				{
					to: '/packages',
					filter: 'disabled',
					label: 'Disabled',
					Icon: PowerOff,
					count: disabledCount,
				},
			],
		},
		{
			label: 'System',
			items: [
				{
					to: '/settings/about',
					label: 'Shell updates',
					Icon: Box,
					count: shellUpdateCount,
					tone: shellUpdateCount ? 'attention' : undefined,
				},
				{ to: '/pkg-kernel-status', label: 'Kernel status', Icon: Activity },
				{ to: '/install', label: 'Install from path', Icon: PackagePlus },
				{ to: '/settings/about', label: 'About Ikenga', Icon: Info },
			],
		},
	];

	function isActive(item: NavItem): boolean {
		if (item.to !== active.path) return false;
		// For the /packages route, also match the filter param. `all` is the
		// default and matches both an explicit `?filter=all` and a bare URL.
		if (item.to === '/packages' && item.filter) {
			const cur = active.filter ?? 'all';
			return cur === item.filter;
		}
		return true;
	}

	function go(item: NavItem) {
		if (item.to === '/packages' && item.filter && item.filter !== 'all') {
			navigateFocused(`${item.to}?filter=${item.filter}`);
		} else {
			navigateFocused(item.to);
		}
	}

	return (
		<div className="h-full overflow-y-auto py-2">
			{NAV.map((sec) => (
				<div key={sec.label} className="mb-3">
					<div className="px-4 pb-1 pt-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
						{sec.label}
					</div>
					<ul className="flex flex-col">
						{sec.items.map((item) => {
							const active = isActive(item);
							return (
								<li key={`${item.to}-${item.filter ?? ''}-${item.label}`}>
									<button
										type="button"
										onClick={() => go(item)}
										className={cn(
											'flex w-full items-center gap-3 px-4 py-1.5 text-left text-sm transition-colors',
											'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
											active && 'bg-accent text-accent-foreground font-medium'
										)}
									>
										<item.Icon className="h-4 w-4 shrink-0" />
										<span className="flex-1 truncate">{item.label}</span>
										{typeof item.count === 'number' && (
											<span
												className={cn(
													'rounded-sm border px-1.5 py-px font-mono text-[10px]',
													item.tone === 'attention'
														? 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400'
														: item.tone === 'warn'
															? 'border-red-500/40 bg-red-500/10 text-red-500'
															: 'border-border bg-background text-muted-foreground'
												)}
											>
												{item.count}
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
