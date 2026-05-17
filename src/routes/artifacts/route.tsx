// Artifact-grid filter deep-links. Sidebar items in `ArtifactGridMode`
// all navigate here; the `?filter=` search param selects which slice of
// the active project's catalog is shown.
//
// Renders `StudioGrid` (artifact-studio at grid density) over the
// active project's `root_path`. When there is no active project, shows
// an inline empty state nudging the user to /settings/projects.
//
// Plan: plans/shell/2026-05-17-projects-and-artifact-wizard.md §B3.

import { Link, createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';

import { useShellStore } from '@/lib/shell/shell-store';
import { usePaneScope } from '@/shell/panes/views/route-view';
import { StudioGrid } from '@/shell/artifact-studio/density/grid';

const FILTER_VALUES = [
	'all',
	'recent',
	'starred',
	'type:dashboard',
	'type:one-pager',
	'type:slides',
	'type:social',
	'type:site',
	'type:scrollytelling',
	'drafts',
	'open-pins',
] as const;

const searchSchema = z.object({
	filter: z.enum(FILTER_VALUES).optional(),
});

export const Route = createFileRoute('/artifacts')({
	component: ArtifactsRoute,
	validateSearch: searchSchema,
});

function ArtifactsRoute() {
	// `filter` is read off the URL by sidebar items (the deep-link target)
	// but not yet plumbed into StudioGrid — see TODO below.
	Route.useSearch();
	const paneScope = usePaneScope();
	const activeProjectId = useShellStore((s) => s.activeProjectId);
	const projects = useShellStore((s) => s.projects);
	const active = projects.find((p) => p.id === activeProjectId);
	const projectRoot = active?.root_path ?? null;

	// `usePaneScope` returns the pane id when this route is mounted inside
	// a pane's memory router (the common case via `navigateFocused`). Falls
	// back to a stable synthetic id when rendered at the shell root.
	const paneId = paneScope ?? 'artifacts-route';

	if (!projectRoot) {
		return (
			<div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
				<div className="text-sm font-medium">No active project</div>
				<div className="max-w-sm text-xs text-muted-foreground">
					The artifact grid is project-scoped. Pick or register a project to see its catalog.
				</div>
				<Link
					to="/settings/projects"
					className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
				>
					Open Settings → Projects
				</Link>
			</div>
		);
	}

	// TODO(phase-B+): plumb `_search.filter` into `StudioGrid` so deep-link
	//   sidebar items actually narrow the grid. Today `StudioGrid` owns its
	//   own internal Open/All filter pill; a second URL-driven dimension
	//   (Recent / Starred / type:* / Drafts / Open pins) needs either:
	//     (a) a new `initialFilter` prop on StudioGrid + a `manifest.notes.*`
	//         walker for the catalog enumeration, or
	//     (b) a thin wrapper that filters the StudioGrid `listing` query
	//         result before render. (b) is cheaper but requires StudioGrid
	//         to expose its listing query key for invalidation. Either way
	//         it's outside the B3 scope — the route renders the grid,
	//         which is the load-bearing surface.
	return <StudioGrid path={projectRoot} paneId={paneId} />;
}
