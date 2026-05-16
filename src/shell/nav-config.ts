// Default sidebar entries for App mode. These are shell-internal surfaces
// only — app pkgs contribute their own nav via the UiRoutesRegistry and
// declarative `ui.nav` blocks in their manifests, surfaced by the kernel
// snapshot. The pkg-aware sidebar is rendered alongside this list inside
// AppMode so users can launch installed pkgs without needing a custom
// per-pkg rail icon.

import {
	Bot,
	CheckSquare,
	FileText,
	Home,
	Package,
	PackagePlus,
	Terminal as TerminalIcon,
} from 'lucide-react';

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
			{ to: '/claude', label: 'Claude', Icon: Bot },
		],
	},
	{
		label: 'Project',
		items: [
			{ to: '/scratchpads', label: 'Scratchpads', Icon: FileText },
			{ to: '/todos', label: 'Todos', Icon: CheckSquare },
		],
	},
	{
		label: 'Packages',
		items: [
			{ to: '/packages', label: 'Installed', Icon: Package },
			{ to: '/install', label: 'Install', Icon: PackagePlus },
		],
	},
];
