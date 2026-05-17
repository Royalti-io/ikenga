// Artifact-grid sidebar. Activated by the activity-bar Artifact-grid icon (⌘5).
// Plan: plans/shell/2026-05-17-projects-and-artifact-wizard.md §B1.
//
// Mirrors `pkgs-mode.tsx` structure: catalog / attention / tools / project
// sections, each a list of routes (+ optional `filter` query param) that
// `navigateFocused()` jumps to. Counts come from `artifactGridCatalogQueryOptions`
// scoped to the active project; slots without a real data source today
// stay `undefined` and the badge stays hidden (see TODOs).

import {
	ArrowDownToLine,
	CheckCircle2,
	FileText,
	Folder,
	FolderCog,
	Globe,
	Image,
	LayoutGrid,
	LayoutTemplate,
	Layers,
	Link2,
	MessageSquare,
	Plus,
	Presentation,
	Settings2,
	Sparkles,
	Star,
	type LucideIcon,
} from 'lucide-react';

import { useQuery } from '@tanstack/react-query';
import { useShallow } from 'zustand/react/shallow';

import { cn } from '@/components/ui/utils';
import { findLeaf } from '@/lib/panes/pane-reducer';
import { usePaneStore } from '@/lib/panes/pane-store';
import { artifactGridCatalogQueryOptions } from '@/lib/queries/artifact-grid';
import { useShellStore } from '@/lib/shell/shell-store';

// Filter keys that travel through `/artifacts?filter=…`. Mirrored by the
// `validateSearch` enum in `routes/artifacts/route.tsx` — keep in sync.
type FilterKey =
	| 'all'
	| 'recent'
	| 'starred'
	| 'type:dashboard'
	| 'type:one-pager'
	| 'type:slides'
	| 'type:social'
	| 'type:site'
	| 'type:scrollytelling'
	| 'drafts'
	| 'open-pins';

interface NavItem {
	to: string;
	filter?: FilterKey;
	label: string;
	Icon: LucideIcon;
	count?: number;
	tone?: 'attention' | 'warn';
	/** When true, item is greyed out / disabled (still rendered for shape). */
	disabled?: boolean;
}

interface NavSection {
	label: string;
	items: NavItem[];
}

export function ArtifactGridMode() {
	const navigateFocused = usePaneStore((s) => s.navigateFocused);
	const { activeProjectId, projects } = useShellStore(
		useShallow((s) => ({
			activeProjectId: s.activeProjectId,
			projects: s.projects,
		}))
	);
	const activeProject = projects.find((p) => p.id === activeProjectId);
	const projectRoot = activeProject?.root_path ?? null;

	const catalogQuery = useQuery(artifactGridCatalogQueryOptions(activeProjectId, projectRoot));
	const openPinsCount = catalogQuery.data?.openPins;
	const resolvedWeekCount = catalogQuery.data?.resolvedThisWeek;

	// Track both pane path and `?filter=` so the active item highlights
	// correctly when deep-linked. `useShallow` matches the PkgsMode
	// boot-loop guard (fresh object every selector call would otherwise
	// trip useSyncExternalStore under Zustand v5 + React 19).
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

	// TODO(phase-B+): wire `All / Recent / Starred / By type / Drafts`
	//   counts. Today there's no project-scoped artifact enumeration
	//   command — a recursive walk over `<root>` for `*.html` files +
	//   per-file manifest parsing has to land before these badges can
	//   be populated. Keep them `undefined` so the badge stays hidden.
	const NAV: NavSection[] = [
		{
			label: 'Catalog',
			items: [
				{ to: '/artifacts', filter: 'all', label: 'All artifacts', Icon: LayoutGrid },
				{ to: '/artifacts', filter: 'recent', label: 'Recent', Icon: Sparkles },
				{ to: '/artifacts', filter: 'starred', label: 'Starred', Icon: Star },
				{
					to: '/artifacts',
					filter: 'type:dashboard',
					label: 'Dashboards',
					Icon: LayoutTemplate,
				},
				{ to: '/artifacts', filter: 'type:one-pager', label: 'One-pagers', Icon: FileText },
				{ to: '/artifacts', filter: 'type:slides', label: 'Slides', Icon: Presentation },
				{ to: '/artifacts', filter: 'type:social', label: 'Social', Icon: Image },
				{ to: '/artifacts', filter: 'type:site', label: 'Sites', Icon: Globe },
				{
					to: '/artifacts',
					filter: 'type:scrollytelling',
					label: 'Scrollytelling',
					Icon: Layers,
				},
			],
		},
		{
			label: 'Attention',
			items: [
				// TODO(phase-B+): "Drafts" heuristic — artifact whose manifest
				//   has no `version` or starts with `0.`. Requires the catalog
				//   walk above; leave count undefined for now.
				{ to: '/artifacts', filter: 'drafts', label: 'Drafts', Icon: FileText },
				{
					to: '/artifacts',
					filter: 'open-pins',
					label: 'Open pins',
					Icon: MessageSquare,
					count: openPinsCount,
					tone: openPinsCount && openPinsCount > 0 ? 'attention' : undefined,
				},
				{
					to: '/artifacts',
					filter: 'open-pins',
					label: 'Resolved this week',
					Icon: CheckCircle2,
					count: resolvedWeekCount,
				},
			],
		},
		{
			label: 'Tools',
			items: [
				// Owned by Phase C (`/projects/new-artifact`). Until that lands
				// this link 404s — intentional, the user sees the in-flight
				// surface as soon as it ships without sidebar churn.
				{ to: '/projects/new-artifact', label: '+ New artifact', Icon: Plus },
				{
					to: '/artifacts',
					label: 'Import from URL',
					Icon: ArrowDownToLine,
					disabled: true,
				},
				{
					to: '/packages',
					label: 'Browse registry',
					Icon: Link2,
					disabled: true,
				},
			],
		},
		{
			label: 'Project',
			items: [
				{
					to: '/settings/projects',
					label: activeProject
						? `Switch project · ${activeProject.display_name}`
						: 'Switch project',
					Icon: Folder,
				},
				{ to: '/settings/projects', label: 'Project settings', Icon: FolderCog },
				{ to: '/settings/artifact-grid', label: 'Grid settings', Icon: Settings2 },
			],
		},
	];

	function isActive(item: NavItem): boolean {
		if (item.to !== active.path) return false;
		// `/artifacts` defaults to filter=all when the URL is bare.
		if (item.to === '/artifacts' && item.filter) {
			const cur = active.filter ?? 'all';
			return cur === item.filter;
		}
		return true;
	}

	function go(item: NavItem) {
		if (item.disabled) return;
		if (item.to === '/artifacts' && item.filter && item.filter !== 'all') {
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
							const isCurrent = isActive(item);
							return (
								<li key={`${item.to}-${item.filter ?? ''}-${item.label}`}>
									<button
										type="button"
										onClick={() => go(item)}
										disabled={item.disabled}
										className={cn(
											'flex w-full items-center gap-3 px-4 py-1.5 text-left text-sm transition-colors',
											'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
											isCurrent && 'bg-accent text-accent-foreground font-medium',
											item.disabled && 'cursor-not-allowed opacity-50 hover:bg-transparent'
										)}
									>
										<item.Icon className="h-4 w-4 shrink-0" />
										<span className="flex-1 truncate">{item.label}</span>
										{typeof item.count === 'number' && item.count > 0 && (
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
