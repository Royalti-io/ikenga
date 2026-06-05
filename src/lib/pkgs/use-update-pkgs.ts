// Batch pkg-update mutation. Given a set of installed rows that each carry a
// `registryEntry` (populated by use-derived when a newer version exists),
// resolve each pkg's signed dep-plan and re-install over the existing path.
// The kernel treats a same-path re-install as an in-place upgrade —
// unregister → re-register → emit `pkg-reloaded` — so mounted iframes remount
// without a shell restart.
//
// Powers both the "Update all" button on the /packages surface and the
// background auto-updater mounted in the workspace.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchPkgDetail, resolveInstallPlan, type PkgDetail } from '@/lib/registry/client';
import { registryKeys, useRegistryIndex } from '@/lib/registry/use-registry';
import { pkgInstallFromRegistry } from '@/lib/tauri-cmd';
import type { PkgRowV2 } from './use-derived';

export interface UpdateProgress {
	/** Index of the pkg currently being updated (0-based). */
	done: number;
	/** Total pkgs in this batch. */
	total: number;
	/** Display name of the pkg currently being updated. */
	current: string;
}

export interface UpdatePkgsArgs {
	rows: PkgRowV2[];
	onProgress?: (p: UpdateProgress) => void;
}

/** One pkg that failed to update; the rest of the batch still ran. */
export interface UpdateFailure {
	id: string;
	name: string;
	error: string;
}

export interface UpdatePkgsResult {
	/** Count of pkgs updated successfully. */
	updated: number;
	/** Per-pkg failures. A failure no longer aborts the batch — surface these
	 *  to the user (they used to be swallowed entirely, which looked like
	 *  "progress bar ran, nothing happened"). */
	failed: UpdateFailure[];
}

export function useUpdatePkgs() {
	const qc = useQueryClient();
	const indexQuery = useRegistryIndex();
	const indexUrl = indexQuery.data?.indexUrl;

	// Session-cached detail fetch, shared with the resolver. Mirrors the
	// getDetail in useInstallPlanResolver so any pkg the user already inspected
	// won't refetch.
	const getDetail = async (name: string): Promise<PkgDetail> => {
		const cached = qc.getQueryData<PkgDetail>(registryKeys.detail(name));
		if (cached) return cached;
		if (!indexUrl) throw new Error('registry index not available');
		const detail = await fetchPkgDetail(indexUrl, { name });
		qc.setQueryData(registryKeys.detail(name), detail);
		return detail;
	};

	return useMutation({
		mutationFn: async ({ rows, onProgress }: UpdatePkgsArgs): Promise<UpdatePkgsResult> => {
			const targets = rows.filter((r) => r.registryEntry && r.latest && r.latest !== r.version);
			let done = 0;
			const failed: UpdateFailure[] = [];
			for (const row of targets) {
				onProgress?.({ done: done + failed.length, total: targets.length, current: row.name });
				try {
					const root = await getDetail(row.registryEntry!.name);
					const plan = await resolveInstallPlan(root, getDetail);
					for (const step of plan) {
						await pkgInstallFromRegistry({
							tarball: step.tarball,
							integrity: step.integrity,
							pkgId: step.pkgId,
							sourceUrl: step.tarball,
						});
					}
					done += 1;
				} catch (e) {
					// One bad pkg must not abort the rest of the batch — record it
					// and keep going; callers render the failures.
					failed.push({
						id: row.id,
						name: row.name,
						error: e instanceof Error ? e.message : String(e),
					});
				}
			}
			onProgress?.({ done: done + failed.length, total: targets.length, current: '' });
			return { updated: done, failed };
		},
		onSettled: () => {
			// Settled, not success: even a batch that ends with failures may have
			// installed some pkgs before the failing row — refetch regardless.
			void qc.invalidateQueries({ queryKey: ['pkg'] });
			void qc.invalidateQueries({ queryKey: registryKeys.all });
		},
	});
}
