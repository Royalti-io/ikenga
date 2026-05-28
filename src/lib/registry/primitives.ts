// Primitive catalog (Ọba WP-10) — the "recommended / available to install"
// feed for standalone Claude-config primitives (skills/agents/commands/hooks/
// mcp). The primitive-level analog of the pkg registry index (./client.ts).
//
// SOURCE (decided 2026-05-28, see plans/oba-registry/04-discussion.md Round 3):
// a dedicated, signed `primitives.json` published to the ikenga-registry
// (GitHub Pages), fetched + minisign-verified exactly like the pkg index. That
// remote catalog doesn't exist yet — publishing + signing is WP-10b — so this
// read-only slice (WP-10a) ships a BUNDLED starter catalog in the same shape.
// Swapping to the remote source is a one-function change in
// `fetchPrimitiveCatalog` (mirror `client.ts::fetchIndex`).
//
// Install / update actions are gated on Phase 2 (git/npx install + update,
// WP-07–09) — a catalog entry is only a POINTER that resolves to a git/npx
// master, so it cannot be installed until that machinery exists. Until then
// the UI shows Install/Update disabled-pending.

import { useQuery } from '@tanstack/react-query';
import { semverCompare } from '@ikenga/registry-client';

import type { ClaudeStoreEntry, ClaudeStoreKind } from '@/lib/tauri-cmd';
import seed from './primitives-seed.json';

/** One installable primitive in the Ọba catalog. `source`/`url` are the
 *  discovery origin the Phase-2 installer resolves (`source:"catalog"` is
 *  recorded as provenance once installed). */
export interface PrimitiveCatalogEntry {
	kind: ClaudeStoreKind;
	name: string;
	version: string;
	description: string | null;
	/** Where install resolves under the hood (Phase 2). */
	source: 'git' | 'npx';
	/** git remote URL | npm/skills spec. */
	url: string;
	publisher?: string | null;
}

export interface PrimitiveCatalog {
	$schemaVersion: number;
	updatedAt: string;
	primitives: PrimitiveCatalogEntry[];
}

/** Fetch the primitive catalog. WP-10a: returns the bundled seed. WP-10b will
 *  fetch + minisign-verify `…/ikenga-registry/primitives.json` (mirroring
 *  `fetchIndex`) and fall back to the seed only if the remote is absent. */
export async function fetchPrimitiveCatalog(): Promise<PrimitiveCatalogEntry[]> {
	return (seed as PrimitiveCatalog).primitives;
}

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

export const primitiveCatalogKey = ['registry', 'primitives'] as const;

export function usePrimitiveCatalog() {
	return useQuery({
		queryKey: primitiveCatalogKey,
		queryFn: () => fetchPrimitiveCatalog(),
		staleTime: SIX_HOURS_MS,
		refetchOnWindowFocus: false,
	});
}

export type PrimitiveStatus = 'installed' | 'updatable' | 'available';

/** One row in the merged store-surface view: a local store entry, a catalog
 *  recommendation, or both (installed + catalog-known). */
export interface PrimitiveViewItem {
	key: string;
	kind: ClaudeStoreKind;
	name: string;
	description: string | null;
	status: PrimitiveStatus;
	/** Present when installed (canonical copy in the local store). */
	store: ClaudeStoreEntry | null;
	/** Present when the catalog lists it. */
	catalog: PrimitiveCatalogEntry | null;
}

/** Merge the local store (what's installed) with the catalog (what's
 *  available) into one status-tagged list. Installed entries whose catalog
 *  version is newer than the recorded store version are `updatable`;
 *  catalog-only entries are `available`; everything else installed is
 *  `installed`. Store entries lead; catalog-only entries follow. */
export function mergePrimitiveView(
	store: ClaudeStoreEntry[],
	catalog: PrimitiveCatalogEntry[]
): PrimitiveViewItem[] {
	const catByKey = new Map<string, PrimitiveCatalogEntry>();
	for (const c of catalog) catByKey.set(`${c.kind}:${c.name}`, c);

	const out: PrimitiveViewItem[] = [];
	const installed = new Set<string>();
	for (const e of store) {
		const key = `${e.kind}:${e.name}`;
		installed.add(key);
		const cat = catByKey.get(key) ?? null;
		const updatable =
			cat != null && e.version != null && semverCompare(e.version, cat.version) < 0;
		out.push({
			key: `store:${key}`,
			kind: e.kind,
			name: e.name,
			description: e.description,
			status: updatable ? 'updatable' : 'installed',
			store: e,
			catalog: cat,
		});
	}
	for (const c of catalog) {
		const key = `${c.kind}:${c.name}`;
		if (installed.has(key)) continue;
		out.push({
			key: `cat:${key}`,
			kind: c.kind,
			name: c.name,
			description: c.description,
			status: 'available',
			store: null,
			catalog: c,
		});
	}
	return out;
}

export const PRIMITIVE_STATUS_WORD: Record<PrimitiveStatus, string> = {
	installed: 'Installed',
	updatable: 'Update available',
	available: 'Available',
};
