// Phase 5 — Hook: read manifests of every installed pkg.
//
// The connector banner + Settings → Integrations cards both need to walk
// installed pkgs and ask "which connectors does this pkg declare?".
// `pkgKernelStatus` only returns the per-pkg summary (id, version,
// install_path, enabled), so we follow it with one `pkgPreviewManifest`
// per pkg to surface the `capabilities` / `permissions['vault.keys']`
// blocks the resolver reads.

import { useQuery } from '@tanstack/react-query';

import type { ManifestLike } from '@/lib/onboarding/connectors';
import { type PkgInstalledSummary, pkgKernelStatus, pkgPreviewManifest } from '@/lib/tauri-cmd';

export interface InstalledManifest {
	pkgId: string;
	display: string;
	manifest: ManifestLike;
	enabled: boolean;
}

const QUERY_KEY = ['onboarding', 'installed-manifests'] as const;

export function useInstalledManifests() {
	return useQuery({
		queryKey: QUERY_KEY,
		queryFn: fetchInstalledManifests,
		staleTime: 30_000,
		refetchOnWindowFocus: false,
	});
}

/**
 * Read installed pkgs from the kernel, then fetch each one's manifest in
 * parallel. Failures fall back to a minimal `{ id }` manifest so the
 * resolver still sees the pkg id (it just won't trigger any connectors).
 */
export async function fetchInstalledManifests(): Promise<InstalledManifest[]> {
	let installed: PkgInstalledSummary[] = [];
	try {
		const status = await pkgKernelStatus();
		installed = status.installed;
	} catch {
		return [];
	}
	const previews = await Promise.all(
		installed.map(async (pkg) => {
			try {
				const m = await pkgPreviewManifest(pkg.install_path);
				return {
					pkgId: pkg.id,
					display: (m.name as string | undefined) ?? pkg.id,
					manifest: previewToManifest(pkg.id, m),
					enabled: pkg.enabled,
				};
			} catch {
				return {
					pkgId: pkg.id,
					display: pkg.id,
					manifest: { id: pkg.id },
					enabled: pkg.enabled,
				};
			}
		})
	);
	return previews;
}

function previewToManifest(
	id: string,
	preview: { capabilities?: unknown; permissions?: Record<string, unknown> }
): ManifestLike {
	const capsRaw = preview.capabilities as { supabase?: { required?: boolean } } | undefined;
	const perms = preview.permissions ?? {};
	const vaultKeys = Array.isArray(perms['vault.keys']) ? (perms['vault.keys'] as string[]) : [];
	return {
		id,
		capabilities: capsRaw?.supabase
			? { supabase: { required: !!capsRaw.supabase.required } }
			: null,
		permissions: { 'vault.keys': vaultKeys },
	};
}

/** Test helper — keeps the transform unit-testable without TanStack Query. */
export { previewToManifest as _previewToManifest };
