// Shell-side wrapper around @ikenga/registry-client. Bakes in the two
// constants that turn a generic library into "the Ikenga registry":
//   - REGISTRY_URL   — where to fetch index.json
//   - REGISTRY_PUBKEY — the minisign public key the index must verify against
//
// Both ship as build-time constants in the shell binary. They are NOT
// configurable at runtime by design: a future "alternative registry"
// feature must explicitly add a new code path, not silently retarget the
// existing one.

import {
	fetchIndex as fetchIndexLib,
	fetchPkgDetail as fetchPkgDetailLib,
	resolveInstallPlan as resolveInstallPlanLib,
	type FetchedIndex,
	type InstallStep,
	type PkgDetail,
	type RegistryEntry,
} from '@ikenga/registry-client';

/** Live registry. Source: docs/plans/2026-05-13-ikenga-pkgs-migration.md Phase C. */
export const REGISTRY_URL = 'https://royalti-io.github.io/ikenga-registry/index.json';

/**
 * Primitive catalog (Ọba WP-10b). A separate signed `primitives.json` published
 * to the same registry host, signed with the same key as `index.json`. Fetched
 * + minisign-verified by `lib/registry/primitives.ts::fetchPrimitiveCatalog`.
 */
export const PRIMITIVES_URL = 'https://royalti-io.github.io/ikenga-registry/primitives.json';

/**
 * Minisign public key for the registry signer. Generated 2026-05-13 by the
 * `update-registry-index.mjs` keypair (NOT the shell updater key — separate
 * trust roots). Hard-coded so the verifier doesn't depend on disk state.
 */
export const REGISTRY_PUBKEY = 'RWRTqugAYXnZRgZPMyuqRNB3G41wg+AhSU2yT8nmDNNQlWQPeCfRXAvI';

export type {
	FetchedIndex,
	InstallStep,
	PkgDetail,
	RegistryEntry,
	RegistryIndex,
	PkgVersion,
} from '@ikenga/registry-client';

/** Fetch + verify the registry index. Throws on any failure (see lib docs). */
export async function fetchIndex(signal?: AbortSignal): Promise<FetchedIndex> {
	return fetchIndexLib({
		indexUrl: REGISTRY_URL,
		publicKey: REGISTRY_PUBKEY,
		signal,
	});
}

/** Lazy detail fetch — used when the user opens the per-pkg pane. */
export async function fetchPkgDetail(
	indexUrl: string,
	entry: RegistryEntry | { name: string },
	signal?: AbortSignal
): Promise<PkgDetail> {
	return fetchPkgDetailLib({ indexUrl, entry, signal });
}

/**
 * Resolve a full install plan for `root` at `version` (or latest).
 * `getDetail` is supplied by the caller so the UI can dedupe detail-file
 * fetches across multiple install flows.
 */
export async function resolveInstallPlan(
	root: PkgDetail,
	getDetail: (name: string) => Promise<PkgDetail>,
	version?: string
): Promise<InstallStep[]> {
	return resolveInstallPlanLib({ root, version, fetchDetail: getDetail });
}
