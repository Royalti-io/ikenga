// Primitive catalog (Ọba WP-10) — the "recommended / available to install"
// feed for standalone Claude-config primitives (skills/agents/commands/hooks/
// mcp). The primitive-level analog of the pkg registry index (./client.ts).
//
// SOURCE (decided 2026-05-28, see plans/oba-registry/04-discussion.md Round 3):
// a dedicated, signed `primitives.json` published to the ikenga-registry
// (GitHub Pages), fetched + minisign-verified exactly like the pkg index.
// WP-10b (this change): `fetchPrimitiveCatalog` now fetches `primitives.json`
// + its `.minisig` from `PRIMITIVES_URL`, verifies the signature against the
// same `REGISTRY_PUBKEY` the pkg index trusts, and validates the payload shape.
// The BUNDLED `primitives-seed.json` is kept as a fallback used ONLY when the
// remote is genuinely ABSENT (network failure / 404) — never when the signature
// or shape fails to verify (a verify failure is treated as hostile and throws,
// mirroring `client.ts::fetchIndex`).
//
// Install / update actions are gated on Phase 2 (git/npx install + update,
// WP-07–09) — a catalog entry is only a POINTER that resolves to a git/npx
// master, so it cannot be installed until that machinery exists. Until then
// the UI shows Install/Update disabled-pending.

import { useQuery } from '@tanstack/react-query';
import { semverCompare, verifyMinisign } from '@ikenga/registry-client';

import type { ClaudeStoreEntry, ClaudeStoreKind, RequiresEntry } from '@/lib/tauri-cmd';
import { PRIMITIVES_URL, REGISTRY_PUBKEY } from './client';
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
	/** Forward dependencies (ADR-015 §3 / WP-15) — the compiled `requires` list
	 *  the publish-time lift writes into the published manifest and which the
	 *  catalog generator auto-carries (the manifest is embedded in each entry).
	 *  Carried on the catalog so the install consent surface can list "also
	 *  installs: <dep> from <provenance>" BEFORE any fetch. The Rust resolver
	 *  remains authoritative at install (it re-reads each fetched manifest);
	 *  this field only drives the pre-install consent display. Absent → no deps. */
	requires?: RequiresEntry[];
}

export interface PrimitiveCatalog {
	$schemaVersion: number;
	updatedAt: string;
	primitives: PrimitiveCatalogEntry[];
}

const KINDS: ReadonlySet<string> = new Set(['skill', 'agent', 'command', 'hook', 'mcp']);
const REQUIRE_SOURCES: ReadonlySet<string> = new Set(['git', 'npx', 'catalog', 'local']);

/** Validate a catalog entry's optional `requires` array (WP-15). Mirrors the
 *  `RequiresEntry` shape ({kind, name, source?, ref?}); throws on a malformed
 *  element so a verified-but-junk catalog is rejected loudly. Returns undefined
 *  when absent (= no deps). */
function parseRequires(raw: unknown, i: number): RequiresEntry[] | undefined {
	if (raw === undefined || raw === null) return undefined;
	if (!Array.isArray(raw)) {
		throw new Error(`primitives.json: entry ${i} \`requires\` is not an array`);
	}
	return raw.map((r, j) => {
		if (typeof r !== 'object' || r === null) {
			throw new Error(`primitives.json: entry ${i} requires[${j}] is not an object`);
		}
		const e = r as Record<string, unknown>;
		if (typeof e.kind !== 'string' || !KINDS.has(e.kind)) {
			throw new Error(`primitives.json: entry ${i} requires[${j}] has invalid kind ${String(e.kind)}`);
		}
		if (typeof e.name !== 'string') {
			throw new Error(`primitives.json: entry ${i} requires[${j}] missing name`);
		}
		if (e.source !== undefined && (typeof e.source !== 'string' || !REQUIRE_SOURCES.has(e.source))) {
			throw new Error(`primitives.json: entry ${i} requires[${j}] has invalid source ${String(e.source)}`);
		}
		if (e.ref !== undefined && typeof e.ref !== 'string') {
			throw new Error(`primitives.json: entry ${i} requires[${j}] has non-string ref`);
		}
		return {
			kind: e.kind,
			name: e.name,
			...(e.source !== undefined ? { source: e.source as RequiresEntry['source'] } : {}),
			...(e.ref !== undefined ? { ref: e.ref as string } : {}),
		};
	});
}

/** Defensive runtime validation of a fetched catalog payload (there is no Zod
 *  schema for `primitives.json` in @ikenga/contract — the pkg index has one,
 *  primitives don't yet). Throws on a malformed payload so a verified-but-junk
 *  catalog is rejected loudly rather than rendering garbage rows. */
function parseCatalog(json: unknown): PrimitiveCatalogEntry[] {
	if (typeof json !== 'object' || json === null) {
		throw new Error('primitives.json: not an object');
	}
	const obj = json as Record<string, unknown>;
	if (!Array.isArray(obj.primitives)) {
		throw new Error('primitives.json: missing `primitives` array');
	}
	return obj.primitives.map((raw, i) => {
		if (typeof raw !== 'object' || raw === null) {
			throw new Error(`primitives.json: entry ${i} is not an object`);
		}
		const e = raw as Record<string, unknown>;
		if (typeof e.kind !== 'string' || !KINDS.has(e.kind)) {
			throw new Error(`primitives.json: entry ${i} has invalid kind ${String(e.kind)}`);
		}
		if (typeof e.name !== 'string' || typeof e.version !== 'string') {
			throw new Error(`primitives.json: entry ${i} missing name/version`);
		}
		if (e.source !== 'git' && e.source !== 'npx') {
			throw new Error(`primitives.json: entry ${i} has invalid source ${String(e.source)}`);
		}
		if (typeof e.url !== 'string') {
			throw new Error(`primitives.json: entry ${i} missing url`);
		}
		return {
			kind: e.kind as ClaudeStoreKind,
			name: e.name,
			version: e.version,
			description: typeof e.description === 'string' ? e.description : null,
			source: e.source,
			url: e.url,
			publisher: typeof e.publisher === 'string' ? e.publisher : null,
			requires: parseRequires(e.requires, i),
		};
	});
}

/** Fetch + minisign-verify the remote primitive catalog (mirrors
 *  `client.ts::fetchIndex`). Returns the bundled seed only when the remote is
 *  genuinely ABSENT (network failure / non-2xx) — a signature or shape failure
 *  THROWS, so a tampered catalog is never silently substituted with the seed. */
export async function fetchPrimitiveCatalog(
	signal?: AbortSignal
): Promise<PrimitiveCatalogEntry[]> {
	const sigUrl = `${PRIMITIVES_URL}.minisig`;
	let raw: Uint8Array;
	let signature: string;
	try {
		const [catRes, sigRes] = await Promise.all([
			fetch(PRIMITIVES_URL, { signal }),
			fetch(sigUrl, { signal }),
		]);
		if (!catRes.ok || !sigRes.ok) {
			// Remote absent (e.g. catalog not yet published / 404). Degrade to the
			// bundled seed rather than failing the surface.
			console.warn(
				`[primitives] remote catalog unavailable (${catRes.status}/${sigRes.status}); using bundled seed`
			);
			return (seed as PrimitiveCatalog).primitives;
		}
		raw = new Uint8Array(await catRes.arrayBuffer());
		signature = await sigRes.text();
	} catch (err) {
		// Network error — treat as absent, fall back to the seed.
		console.warn(
			`[primitives] remote catalog fetch failed (${(err as Error).message}); using bundled seed`
		);
		return (seed as PrimitiveCatalog).primitives;
	}

	// Verify BEFORE parsing — same trust ordering as fetchIndex. A failure here
	// is hostile, not "absent", so it throws and is NOT replaced by the seed.
	const ok = await verifyMinisign(raw, signature, REGISTRY_PUBKEY);
	if (!ok) {
		throw new Error(
			'primitives.json signature did not verify against the configured registry public key'
		);
	}

	let json: unknown;
	try {
		json = JSON.parse(new TextDecoder().decode(raw));
	} catch (err) {
		throw new Error(`primitives.json is not valid JSON: ${(err as Error).message}`);
	}
	return parseCatalog(json);
}

export const primitiveCatalogKey = ['registry', 'primitives'] as const;

export function usePrimitiveCatalog() {
	return useQuery({
		queryKey: primitiveCatalogKey,
		queryFn: ({ signal }) => fetchPrimitiveCatalog(signal),
		// WP-10b fetches the remote signed catalog over the network, so cache it
		// to match the pkg index cadence rather than re-fetching on every mount.
		staleTime: 6 * 60 * 60 * 1000, // ~6h
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
		const updatable = cat != null && e.version != null && semverCompare(e.version, cat.version) < 0;
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

// ─── Forward-dependency consent surface (WP-15) ─────────────────────────────
// The catalog carries `requires`, so the consent dialog can list "X also
// installs: <dep> from <provenance>" with NO extra fetch. This mirrors the Rust
// resolver's closure shape (WP-13) but is a DISPLAY-ONLY pre-flight: the Rust
// `oba_install_with_deps` command re-reads each fetched manifest and remains the
// authoritative installer. We compute the closure here only to drive consent.

/** How a `requires` dependency resolves for the consent surface. */
export type ConsentResolution =
	/** Found in the signed catalog — provenance known, trust inherited from the
	 *  parent install's consent (no extra confirm). */
	| 'catalog'
	/** Not in the catalog but the `requires` entry self-pins a fetch source —
	 *  installable, but pulls un-catalogued code → needs an explicit extra confirm. */
	| 'pinned'
	/** Neither in the catalog nor self-pinned — the resolver cannot fetch it;
	 *  surfaced as a blocking warning + extra confirm. */
	| 'unresolved';

/** One row in the install consent surface — a single dependency in the closure
 *  of the primitive the user asked to install. */
export interface ConsentDep {
	kind: ClaudeStoreKind;
	name: string;
	resolution: ConsentResolution;
	/** Human-readable provenance for display (e.g. "npx · royalti-io/x"). */
	provenance: string;
	/** Already present in the local store — listed, not (re)installed. */
	satisfied: boolean;
	/** Requires the explicit extra confirm (non-catalog / un-pinned dep). */
	needsExtraConfirm: boolean;
}

/** Compute the forward-dependency closure of `target` from the catalog's
 *  `requires` edges, deduped + cycle-guarded, tagged with how each dep resolves
 *  and whether it's already satisfied. DISPLAY-ONLY (drives the WP-15 consent
 *  surface); the Rust resolver re-derives the closure authoritatively at install.
 *  Direct deps lead, transitive deps (revealed only by catalogued parents)
 *  follow. `installedKeys` = `${kind}:${name}` of the local store. */
export function resolveCatalogClosure(
	target: PrimitiveCatalogEntry,
	catalog: PrimitiveCatalogEntry[],
	installedKeys: ReadonlySet<string>
): ConsentDep[] {
	const catByKey = new Map<string, PrimitiveCatalogEntry>();
	for (const c of catalog) catByKey.set(`${c.kind}:${c.name}`, c);

	const out: ConsentDep[] = [];
	const visited = new Set<string>([`${target.kind}:${target.name}`]);
	const queue: RequiresEntry[] = [...(target.requires ?? [])];

	while (queue.length) {
		const r = queue.shift() as RequiresEntry;
		const key = `${r.kind}:${r.name}`;
		if (visited.has(key)) continue;
		visited.add(key);

		const cat = catByKey.get(key) ?? null;
		let resolution: ConsentResolution;
		let provenance: string;
		if (cat) {
			resolution = 'catalog';
			provenance = `${cat.source} · ${cat.url}`;
			// A catalogued dep can reveal its own deps (transitive closure).
			for (const child of cat.requires ?? []) queue.push(child);
		} else if (r.source) {
			resolution = 'pinned';
			provenance = `${r.source}${r.ref ? ` @ ${r.ref}` : ''} · not in catalog`;
		} else {
			resolution = 'unresolved';
			provenance = 'unresolved — not in catalog and no pinned source';
		}

		out.push({
			kind: r.kind as ClaudeStoreKind,
			name: r.name,
			resolution,
			provenance,
			satisfied: installedKeys.has(key),
			needsExtraConfirm: resolution !== 'catalog',
		});
	}
	return out;
}
