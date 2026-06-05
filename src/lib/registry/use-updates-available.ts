// Selector hook for "how many installed pkgs have a newer version in the
// registry?" — drives the activity-bar badge on the Packages entry.
//
// Failure-quiet by design: if either the registry or the kernel status is
// not yet loaded (or errored), we return 0 rather than show a phantom badge.
// Errors are surfaced where they matter (the Browse route + the kernel
// status route).

import { useQuery } from '@tanstack/react-query';
import { pkgKernelStatus } from '@/lib/tauri-cmd';
import { semverCompare } from '@ikenga/registry-client';
import { useRegistryIndex } from './use-registry';

export function useUpdatesAvailable(): number {
	const indexQuery = useRegistryIndex();
	const kernelQuery = useQuery({
		queryKey: ['pkg', 'kernel-status'],
		queryFn: pkgKernelStatus,
		// Already used elsewhere — TanStack dedupes by key, so this is a
		// passive subscriber to whatever the Packages page is fetching.
		refetchOnWindowFocus: false,
	});

	const index = indexQuery.data?.index;
	const installed = kernelQuery.data?.installed;
	if (!index || !installed) return 0;

	// Cross-reference: for each installed pkg, look it up in the registry by
	// the manifest id. Today we don't have an id→registry-name mapping in the
	// index, so we walk linearly — fine at our pkg count. When the index
	// grows beyond ~50 entries this should switch to a precomputed Map.
	//
	// Registry-source installs only — must mirror the filter in
	// use-derived.ts so the badge count matches the /packages update strip
	// (builtins update with the shell; dev/local installs are a working tree
	// the registry can't update in place).
	let count = 0;
	for (const installedPkg of installed) {
		if (installedPkg.source?.kind !== 'registry') continue;
		const entry = index.pkgs.find((p) => entryMatchesPkgId(p.name, installedPkg.id));
		if (!entry) continue;
		if (semverCompare(installedPkg.version, entry.latest) < 0) {
			count++;
		}
	}
	return count;
}

/**
 * Best-effort matcher between an npm name and a manifest id. The registry
 * index lists npm names (`@ikenga/pkg-engine-noop`); the kernel records
 * manifest ids (`com.ikenga.engine-noop`). They're related but not
 * identical, so we match on the suffix.
 *
 * Today's two pkgs both follow the pattern `com.ikenga.<short>` for the id
 * and `@ikenga/pkg-<short>` for the npm name. Until that diverges, suffix
 * matching is enough.
 */
export function entryMatchesPkgId(npmName: string, manifestId: string): boolean {
	const npmShort = npmName.replace(/^@ikenga\//, '').replace(/^pkg-/, '');
	const idShort = manifestId.replace(/^com\.ikenga\./, '');
	return npmShort === idShort;
}
