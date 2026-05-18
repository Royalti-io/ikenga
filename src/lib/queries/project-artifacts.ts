// TanStack query for the project-wide artifact walk.
//
// One fetch, multiple consumers — the artifact-grid sidebar, the (future)
// Studio home page, and the "drafts" / "by type" counts all read off this
// keyed by the active project's root_path. Walk is bounded server-side
// (5000 files, 2MB parse cap, churn-dir skip), so 30s staleTime is fine.

import { queryOptions } from '@tanstack/react-query';

import { type ArtifactRow, projectArtifactsWalk } from '@/lib/tauri-cmd';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export interface ArtifactCounts {
	all: number;
	recent: number;
	starred: number;
	drafts: number;
	/** Rows whose manifest has no `notes.kind` (or no manifest at all). */
	uncategorised: number;
	/** Per-archetype counts. Keys are the archetype slugs the wizard knows. */
	byKind: Record<string, number>;
}

export interface ArtifactCatalog {
	rows: ArtifactRow[];
	counts: ArtifactCounts;
}

/** Heuristic: a row is a "draft" when its manifest is missing, has no
 *  `version`, or the version starts with `0.` (i.e. pre-1.0). */
export function isDraft(row: ArtifactRow): boolean {
	if (!row.has_manifest) return true;
	const v = row.version?.trim() ?? '';
	if (v.length === 0) return true;
	return v.startsWith('0.');
}

export function deriveCounts(rows: ArtifactRow[]): ArtifactCounts {
	const now = Date.now();
	let recent = 0;
	let starred = 0;
	let drafts = 0;
	let uncategorised = 0;
	const byKind: Record<string, number> = {};
	for (const r of rows) {
		if (now - r.modified_at < SEVEN_DAYS_MS) recent += 1;
		if (r.starred) starred += 1;
		if (isDraft(r)) drafts += 1;
		if (r.kind) {
			byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
		} else {
			uncategorised += 1;
		}
	}
	return { all: rows.length, recent, starred, drafts, uncategorised, byKind };
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
