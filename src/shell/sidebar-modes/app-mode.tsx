import { findLeaf } from '@/lib/panes/pane-reducer';
import { usePaneStore } from '@/lib/panes/pane-store';
import { NAV_GROUPS } from '../nav-config';
import { SidebarNav, SidebarNavRow, SidebarNavSection } from './_nav';

// App mode always renders the shell's main nav. Pkgs no longer borrow this
// slot: each app pkg owns its own activity mode (`pkg:<id>`) and the sidebar
// renders its menu there (see `sidebar.tsx` + `activity-bar.tsx`). That keeps
// Home / Sessions / Scratchpads / Todos / Cron reachable while a pkg is open.
export function AppMode() {
	const navigateFocused = usePaneStore((s) => s.navigateFocused);
	// Active highlight tracks the focused pane's active route view (if any).
	const activePath = usePaneStore((s) => {
		const leaf = findLeaf(s.root, s.focusedId);
		if (!leaf) return null;
		const tab = leaf.tabs[leaf.activeTabIdx];
		return tab && tab.kind === 'route' ? tab.path : null;
	});

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
