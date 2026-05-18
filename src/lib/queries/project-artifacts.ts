// TanStack query for the project-wide artifact walk.
//
// One fetch, multiple consumers — the artifact-grid sidebar and the
// Studio home page — keyed by the active project's root_path. Walk is
// bounded server-side (5000 files, 2MB parse cap, churn-dir skip), so
// 30s staleTime is fine.

import { queryOptions } from '@tanstack/react-query';

import { type ArtifactRow, projectArtifactsWalk } from '@/lib/tauri-cmd';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export interface ArtifactCounts {
	all: number;
	recent: number;
	starred: number;
	/** Per-archetype counts. Keys are the archetype slugs the wizard knows.
	 *  Files without a manifest or without `notes.kind` are absent from
	 *  this map. */
	byKind: Record<string, number>;
}

export interface ArtifactCatalog {
	rows: ArtifactRow[];
	counts: ArtifactCounts;
}

export function deriveCounts(rows: ArtifactRow[]): ArtifactCounts {
	const now = Date.now();
	let recent = 0;
	let starred = 0;
	const byKind: Record<string, number> = {};
	for (const r of rows) {
		if (now - r.modified_at < SEVEN_DAYS_MS) recent += 1;
		if (r.starred) starred += 1;
		if (r.kind) {
			byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
		}
	}
	return { all: rows.length, recent, starred, byKind };
}

/** Query factory. Keyed by `rootPath` so switching projects refetches.
 *  Returns `{ rows, counts }` so consumers don't have to re-derive. */
export function projectArtifactsQueryOptions(rootPath: string | null) {
	return queryOptions({
		queryKey: ['project-artifacts', rootPath] as const,
		queryFn: async (): Promise<ArtifactCatalog> => {
			const rows = await projectArtifactsWalk(rootPath);
			return { rows, counts: deriveCounts(rows) };
		},
		staleTime: 30_000,
		// Bounded walk + manifest parse can take ~100-300ms on a medium
		// project. Keep prior data visible while refetching so the sidebar
		// doesn't flash to zero on project switch.
		placeholderData: (prev) => prev,
	});
}
