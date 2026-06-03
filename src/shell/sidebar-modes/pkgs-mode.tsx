// Packages-mode sidebar. Activated by the activity-bar Packages icon (⌘4).
// Mirrors the filter pills inside <PkgsSurface /> as deep-link items so the
// user can jump straight to a focused subset (Updates / Trust / Store / …)
// without first landing on the All view.
//
// Counts are surfaced as live badges next to each item — they come from the
// same `usePkgsDerived` hook the surface itself uses, so the sidebar stays
// in sync without an additional kernel query.

import {
	Activity,
	ArrowUp,
	Ban,
	Box,
	Info,
	LayoutGrid,
	Package,
	PackageCheck,
	PackagePlus,
	PowerOff,
	Shield,
	type LucideIcon,
} from 'lucide-react';

import { useShallow } from 'zustand/react/shallow';

import { findLeaf } from '@/lib/panes/pane-reducer';
import { SidebarNav, SidebarNavRow, SidebarNavSection } from './_nav';
import { usePaneStore } from '@/lib/panes/pane-store';
import { usePkgsDerived } from '@/lib/pkgs/use-derived';
import { useUpdater } from '@/lib/updater/use-updater';

type FilterKey = 'all' | 'installed' | 'updates' | 'store' | 'review' | 'disabled';
type InstallTab = 'manifest-url' | 'local-path' | 'registry';

interface NavItem {
	to: string;
	filter?: FilterKey;
	/** Deep-link that opens the install sheet at this tab on mount. */
	install?: InstallTab;
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
	// `useShallow` is required: this selector returns a fresh object on
	// every call, which under Zustand v5 + React 19 trips
	// `useSyncExternalStore`'s stability check and infinite-loops.
	const active = usePaneStore(
		useShallow((s) => {
			const leaf = findLeaf(s.root, s.focusedId);
			if (!leaf) return { path: null as string | null, filter: null as string | null };
			const tab = leaf.tabs[leaf.activeTabIdx];
			if (!tab || tab.kind !== 'route') return { path: null, filter: null };
			const url = tab.path;
			const [path, qs] = url.split('?');
			const search = new URLSearchParams(qs ?? '');
			return { path, filter: search.get('filter') };
		})
	);

	const disabledCount = d.installed.filter((p) => !p.enabled).length;
	const reviewCount = d.trust.length + d.violations.length;
	const shellUpdateCount = updater.available ? 1 : 0;

	const NAV: NavSection[] = [
		{
			label: 'Catalog',
			items: [
				{
					to: '/packages',
					filter: 'all',
					label: 'All packages',
					Icon: LayoutGrid,
					count: d.rows.length,
				},
				{
					to: '/packages',
					filter: 'installed',
					label: 'Installed',
					Icon: PackageCheck,
					count: d.installed.length,
				},
				{
					to: '/packages',
					filter: 'store',
					label: 'Store',
					Icon: Package,
					count: d.registry.length,
				},
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
				{
					to: '/packages',
					install: 'local-path',
					label: 'Install from path',
					Icon: PackagePlus,
				},
				{ to: '/settings/about', label: 'About Ikenga', Icon: Info },
			],
		},
	];

	function isActive(item: NavItem): boolean {
		if (item.to !== active.path) return false;
		// "Install from path" is a one-shot trigger — never the active row
		// (the surface clears ?install= immediately on mount).
		if (item.install) return false;
		// For the /packages route, also match the filter param. `all` is the
		// default and matches both an explicit `?filter=all` and a bare URL.
		if (item.to === '/packages' && item.filter) {
			const cur = active.filter ?? 'all';
			return cur === item.filter;
		}
		return true;
	}

	function go(item: NavItem) {
		if (item.install) {
			navigateFocused(`${item.to}?install=${item.install}`);
		} else if (item.to === '/packages' && item.filter && item.filter !== 'all') {
			navigateFocused(`${item.to}?filter=${item.filter}`);
		} else {
			navigateFocused(item.to);
		}
	}

	return (
		<SidebarNav ariaLabel="Packages navigation">
			{NAV.map((sec) => (
				<SidebarNavSection key={sec.label} label={sec.label}>
					{sec.items.map((item) => (
						<SidebarNavRow
							key={`${item.to}-${item.filter ?? ''}-${item.label}`}
							icon={item.Icon}
							label={item.label}
							active={isActive(item)}
							count={item.count}
							tone={item.tone ?? 'default'}
							onSelect={() => go(item)}
						/>
					))}
				</SidebarNavSection>
			))}
		</SidebarNav>
	);
}
