// Default sidebar entries for App mode. These are shell-internal surfaces
// only — app pkgs contribute their own nav via the UiRoutesRegistry and
// declarative `ui.nav` blocks in their manifests, surfaced by the kernel
// snapshot. The pkg-aware sidebar is rendered alongside this list inside
// AppMode so users can launch installed pkgs without needing a custom
// per-pkg rail icon.
//
// Packages-related nav (catalog, updates, trust, store) lives in the
// dedicated Packages mode (activity-bar ⌘4 → PkgsMode); it isn't a
// concern of the main App mode anymore.

import { CheckSquare, FileText, Home, Terminal as TerminalIcon } from 'lucide-react';

export interface NavItem {
	to: string;
	label: string;
	Icon: typeof Home;
}
export interface NavGroup {
	label: string | null;
	items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
	{
		label: null,
		items: [
			{ to: '/', label: 'Home', Icon: Home },
			{ to: '/sessions', label: 'Sessions', Icon: TerminalIcon },
			// `/claude` moved out of App mode into the dedicated Ngwa
			// activity-bar mode (⌘6). See `src/shell/sidebar-modes/ngwa-mode.tsx`.
		],
	},
	{
		label: 'Project',
		items: [
			{ to: '/scratchpads', label: 'Scratchpads', Icon: FileText },
			{ to: '/todos', label: 'Todos', Icon: CheckSquare },
		],
	},
];
