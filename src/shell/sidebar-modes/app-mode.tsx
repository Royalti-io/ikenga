import { NAV_GROUPS } from '../nav-config';
import { PkgMode, pkgIdFromRoute } from './pkg-mode';
import { usePaneStore } from '@/lib/panes/pane-store';
import { findLeaf } from '@/lib/panes/pane-reducer';
import { SidebarNav, SidebarNavRow, SidebarNavSection } from './_nav';

export function AppMode() {
	const navigateFocused = usePaneStore((s) => s.navigateFocused);
	// Active highlight tracks the focused pane's active route view (if any).
	const activePath = usePaneStore((s) => {
		const leaf = findLeaf(s.root, s.focusedId);
		if (!leaf) return null;
		const tab = leaf.tabs[leaf.activeTabIdx];
		return tab && tab.kind === 'route' ? tab.path : null;
	});

	// When the focused pane is on a pkg route, swap the sidebar to the pkg's
	// runtime menu (published via `host.pkg.setMenu`). Matches the documented
	// intent in `nav-config.ts`: "The pkg-aware sidebar is rendered alongside
	// this list inside AppMode". v1 fully replaces the nav-config items; we
	// can fold the home/scratchpads/todos shortcuts back in below the pkg menu
	// if users miss them.
	const pkgId = pkgIdFromRoute(activePath);
	if (pkgId) {
		return <PkgMode pkgId={pkgId} />;
	}

	return (
		<SidebarNav ariaLabel="App navigation">
			{NAV_GROUPS.map((group) => (
				<SidebarNavSection key={group.label ?? 'home'} label={group.label ?? undefined}>
					{group.items.map(({ to, label, Icon }) => {
						const isActive =
							activePath === null
								? false
								: to === '/'
									? activePath === '/'
									: activePath === to || activePath.startsWith(`${to}/`);
						return (
							<SidebarNavRow
								key={to}
								icon={Icon}
								label={label}
								active={isActive}
								onSelect={() => navigateFocused(to)}
							/>
						);
					})}
				</SidebarNavSection>
			))}
		</SidebarNav>
	);
}
