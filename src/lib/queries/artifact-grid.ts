// TanStack Query factories for the artifact-grid sidebar mode.
//
// Counts feeding the catalog / attention sections. Project-scoped via
// `activeProjectId` (carried into the query key per
// plans/shell/2026-05-17-projects-and-artifact-wizard.md §B1).
//
// First cut: the counts that have a real data source today (open pins,
// resolved-this-week) are wired through `commentList`. Catalog counts
// (All / Recent / Starred / By type) require a recursive walk over the
// project root for `*.html` artifacts and per-file manifest parsing —
// not surfaced as a tauri command yet, so those slots return `undefined`
// and the sidebar hides the badge until a heuristic lands.

import { queryOptions } from '@tanstack/react-query';

import { type Comment, commentList } from '@/lib/tauri-cmd';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export interface ArtifactGridCatalog {
	/** Total open pin comments whose `artifactPath` is prefixed by the
	 *  active project's `root_path`. `undefined` when there is no active
	 *  project root to filter by. */
	openPins: number | undefined;
	/** Open pin comments resolved in the last 7 days. */
	resolvedThisWeek: number | undefined;
}

/** Query key + fetcher for the artifact-grid sidebar counts. Keyed by
 *  `projectId` so switching projects refreshes the badge values; the
 *  `projectRoot` travels in the queryFn closure so prefix-matching
 *  doesn't require re-keying. */
export function artifactGridCatalogQueryOptions(projectId: string, projectRoot: string | null) {
	return queryOptions({
		queryKey: ['artifact-grid', 'catalog', projectId] as const,
		queryFn: async (): Promise<ArtifactGridCatalog> => {
			if (!projectRoot) {
				return { openPins: undefined, resolvedThisWeek: undefined };
			}
			// `commentList()` with no path returns the cross-folder inbox.
			// We filter to the active project by `artifactPath` prefix.
			const [openAll, includingResolved] = await Promise.all([
				commentList({ includeResolved: false }),
				commentList({ includeResolved: true }),
			]);
			const prefix = projectRoot.endsWith('/') ? projectRoot : `${projectRoot}/`;
			const inProject = (c: Comment) =>
				c.artifactPath === projectRoot || c.artifactPath.startsWith(prefix);

			const openPins = openAll.filter(inProject).length;
			const now = Date.now();
			const resolvedThisWeek = includingResolved.filter(
				(c) =>
					inProject(c) &&
					c.status === 'resolved' &&
					c.resolvedAt != null &&
					now - c.resolvedAt < SEVEN_DAYS_MS
			).length;

			return { openPins, resolvedThisWeek };
		},
		staleTime: 30_000,
	});
}
