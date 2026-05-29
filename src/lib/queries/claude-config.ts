import { useEffect } from 'react';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';

import {
	claudeConfigListen,
	claudeConfigLoad,
	claudeConfigUnwatch,
	claudeConfigWatch,
	claudePrimitiveCopy,
	claudePrimitiveDisable,
	claudePrimitiveDisableFor,
	claudePrimitiveEnable,
	claudePrimitiveEnableFor,
	claudePrimitiveMove,
	claudePrimitiveRemove,
	claudeStoreImport,
	claudeStoreList,
	ngwaCrossEngineCopy,
	obaBackfillRegistry,
	obaCheckUpdate,
	obaDependents,
	obaForget,
	obaInstallGit,
	obaInstallNpx,
	obaRelinkDependents,
	obaSafeDelete,
	obaUnlinkOne,
	obaUpdate,
	type ClaudeAgent,
	type ClaudeCommand,
	type ClaudeConfig,
	type ClaudeHook,
	type ClaudeMcp,
	type ClaudeSkill,
	type ClaudeStoreEntry,
	type ClaudeStoreKind,
	type ClaudeStoreMutation,
	type ClaudeStoreScope,
	type ConfigFormat,
	type EngineId,
	type KindStatus,
	type NgwaCopyBatchResult,
	type NgwaCopyDestination,
	type NgwaHookFile,
	type NgwaStoreError,
	type NgwaTranscodeMode,
	type ObaRelinkRow,
	type SafeDeleteOutcome,
	type UpdateStatus,
} from '@/lib/tauri-cmd';
import type { PrimitiveCatalogEntry } from '@/lib/registry/primitives';
import { queryKeys } from '@/lib/query-keys';

// Re-export the scan-result entry types plus the Ngwa Phase-2 cross-system
// enums (WP-19) so the engine-grouped facet (WP-20) imports its vocabulary from
// the query module rather than reaching into tauri-cmd. Every entry now carries
// optional `system` / `format` / `status` — consumers treat absent `system` as
// `"claude"` and absent `status` as `"active"`.
export type {
	ClaudeAgent,
	ClaudeCommand,
	ClaudeConfig,
	ClaudeHook,
	ClaudeMcp,
	ClaudeSkill,
	ClaudeStoreEntry,
	ClaudeStoreKind,
	ClaudeStoreMutation,
	ClaudeStoreScope,
	ConfigFormat,
	EngineId,
	KindStatus,
	NgwaCopyBatchResult,
	NgwaCopyDestination,
	NgwaHookFile,
	NgwaStoreError,
	NgwaTranscodeMode,
};

// The query layer is engine-agnostic: `claudeConfigLoad` returns the same
// `ClaudeConfig` shape whether it resolves the live Rust scan or the WP-19
// multi-engine dev mock (gated by `NGWA_SCAN_MOCK` in tauri-cmd.ts). The new
// per-entry `system` / `format` / `status` fields flow straight through this
// query into WP-20's engine-grouped facet — no extra mapping here.
export function claudeConfigQueryOptions(projectRoots: readonly string[]) {
	const roots = [...projectRoots];
	return queryOptions({
		queryKey: queryKeys.claudeConfig.load(roots),
		queryFn: () => claudeConfigLoad(roots),
		// The watcher invalidates on change; idle staleness is fine.
		staleTime: 60_000,
	});
}

/** Spin up a watcher for the supplied project roots and personal `~/.claude/`,
 *  invalidating the matching query on any FS change. Releases watchers and
 *  the listener on unmount.
 */
export function useClaudeConfigWatch(projectRoots: readonly string[], enabled = true) {
	const queryClient = useQueryClient();
	// Stable stringified key — re-attach when the root set changes.
	const key = [...projectRoots].sort().join('|');
	useEffect(() => {
		if (!enabled) return;
		let cancelled = false;
		let unlisten: (() => void) | null = null;
		let watcherIds: string[] = [];
		const debounce = makeDebounce(150);
		void (async () => {
			try {
				const ids = await claudeConfigWatch([...projectRoots]);
				if (cancelled) {
					await claudeConfigUnwatch(ids);
					return;
				}
				watcherIds = ids;
				unlisten = await claudeConfigListen(ids, () => {
					debounce(() => {
						queryClient.invalidateQueries({ queryKey: queryKeys.claudeConfig.all });
					});
				});
			} catch (e) {
				// eslint-disable-next-line no-console
				console.warn('[claude-config] watch failed', e);
			}
		})();
		return () => {
			cancelled = true;
			if (unlisten) unlisten();
			if (watcherIds.length) {
				void claudeConfigUnwatch(watcherIds);
			}
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [key, enabled]);
}

function makeDebounce(ms: number) {
	let t: ReturnType<typeof setTimeout> | null = null;
	return (fn: () => void) => {
		if (t) clearTimeout(t);
		t = setTimeout(fn, ms);
	};
}

// ─── Ngwa central store (Ọba) — catalog query + mutation hooks ───────────────
//
// Mirrors the `secrets.ts` mutation→invalidate pattern: each mutation calls its
// `tauri-cmd` wrapper and, onSuccess, invalidates the affected query keys. Every
// store mutation invalidates BOTH the store catalog (`claudeStore.all`, drives
// the per-scope `enabledIn` badges) AND the on-disk scan (`claudeConfig.all`,
// which reflects the new symlink / merged-fragment state and otherwise only
// refreshes on the FS watcher's `claude-config:changed` tick).
//
// Until WP-02/03 register the Rust commands, the wrappers resolve typed canned
// data via the dev-flag mock in `tauri-cmd.ts` (see `NGWA_STORE_MOCK`).

/** Query the central-store catalog, optionally filtered by primitive kind. */
export function claudeStoreQueryOptions(kind?: ClaudeStoreKind | null) {
	return queryOptions({
		queryKey: queryKeys.claudeStore.list(kind ?? null),
		queryFn: () => claudeStoreList(kind ?? null),
		staleTime: 30_000,
	});
}

/**
 * Live dependents of a primitive's canonical master (Ọba registry, WP-04) —
 * symlinks across scopes/engines that resolve into it. Loaded on demand when
 * the detail-pane safe-delete guard opens. Short stale time: dependents reflect
 * live filesystem state and can change out-of-band.
 */
export function obaDependentsQueryOptions(kind: ClaudeStoreKind, name: string) {
	return queryOptions({
		queryKey: [...queryKeys.claudeStore.all, 'dependents', kind, name] as const,
		queryFn: () => obaDependents(kind, name),
		staleTime: 5_000,
	});
}

/**
 * Guarded delete of a primitive's canonical master (WP-04). Returns the
 * `SafeDeleteOutcome` so the caller can branch on the verdict (a refusal is a
 * normal outcome, not an error — the UI renders the relink chooser). Invalidates
 * the store + scan on any outcome that touched disk.
 */
export function useSafeDelete() {
	const invalidate = useInvalidateClaudeStore();
	return useMutation<SafeDeleteOutcome, Error, { kind: ClaudeStoreKind; name: string }>({
		mutationFn: ({ kind, name }) => obaSafeDelete(kind, name),
		onSuccess: (outcome) => {
			if (outcome.removed) invalidate();
		},
	});
}

/** Relink-all: re-point dependent symlinks at a new master before forgetting it. */
export function useRelinkDependents() {
	const invalidate = useInvalidateClaudeStore();
	return useMutation<ObaRelinkRow[], Error, { dependents: string[]; newMaster: string }>({
		mutationFn: ({ dependents, newMaster }) => obaRelinkDependents(dependents, newMaster),
		onSuccess: invalidate,
	});
}

/** Unlink one dependent placement (a symlink) by absolute path (D-01). */
export function useUnlinkOne() {
	const invalidate = useInvalidateClaudeStore();
	return useMutation<boolean, Error, { path: string }>({
		mutationFn: ({ path }) => obaUnlinkOne(path),
		onSuccess: invalidate,
	});
}

/** Forget a primitive from the registry — provenance only, no files touched (D-01). */
export function useForgetFromRegistry() {
	const invalidate = useInvalidateClaudeStore();
	return useMutation<boolean, Error, { kind: ClaudeStoreKind; name: string }>({
		mutationFn: ({ kind, name }) => obaForget(kind, name),
		onSuccess: invalidate,
	});
}

/** Back-fill the registry with external masters discovered in the live farm. */
export function useBackfillRegistry() {
	const invalidate = useInvalidateClaudeStore();
	return useMutation<number, Error, void>({
		mutationFn: () => obaBackfillRegistry(),
		onSuccess: invalidate,
	});
}

/**
 * Install a catalog primitive into the vault (Ọba Phase 2 · WP-10c). Routes to
 * `oba_install_git` / `oba_install_npx` by the entry's `source`. Invalidating the
 * store list re-tallies the Installed/Available/Updatable chips (the merged view
 * recomputes from the new store), so the catalog query itself need not refetch.
 */
export function useObaInstall() {
	const invalidate = useInvalidateClaudeStore();
	return useMutation<ClaudeStoreEntry, Error, PrimitiveCatalogEntry>({
		mutationFn: (entry) =>
			entry.source === 'npx'
				? obaInstallNpx(entry.kind, entry.name, entry.url)
				: obaInstallGit(entry.kind, entry.name, entry.url, null),
		onSuccess: invalidate,
	});
}

/** Re-fetch a managed primitive into its canonical in place (Ọba Phase 2 · WP-09). */
export function useObaUpdate() {
	const invalidate = useInvalidateClaudeStore();
	return useMutation<ClaudeStoreEntry, Error, { kind: ClaudeStoreKind; name: string }>({
		mutationFn: ({ kind, name }) => obaUpdate(kind, name),
		onSuccess: invalidate,
	});
}

/** On-demand update check for a git/npx-installed primitive (read-only). */
export function obaCheckUpdateQueryOptions(kind: ClaudeStoreKind, name: string) {
	return queryOptions({
		queryKey: [...queryKeys.claudeStore.all, 'update-check', kind, name] as const,
		queryFn: (): Promise<UpdateStatus> => obaCheckUpdate(kind, name),
		staleTime: 5 * 60 * 1000,
	});
}

/** Invalidate the store catalog + the on-disk scan after any store mutation. */
function useInvalidateClaudeStore() {
	const qc = useQueryClient();
	return () => {
		qc.invalidateQueries({ queryKey: queryKeys.claudeStore.all });
		qc.invalidateQueries({ queryKey: queryKeys.claudeConfig.all });
	};
}

/** Import an on-disk primitive into the central store. */
export function useImportToStore() {
	const invalidate = useInvalidateClaudeStore();
	return useMutation<
		ClaudeStoreEntry,
		Error,
		{ kind: ClaudeStoreKind; name: string; sourcePath: string }
	>({
		mutationFn: ({ kind, name, sourcePath }) => claudeStoreImport(kind, name, sourcePath),
		onSuccess: invalidate,
	});
}

/** Enable a store catalog entry in a target scope. */
export function useEnablePrimitive() {
	const invalidate = useInvalidateClaudeStore();
	return useMutation<
		ClaudeStoreMutation,
		Error,
		{ kind: ClaudeStoreKind; name: string; scope: ClaudeStoreScope }
	>({
		mutationFn: ({ kind, name, scope }) => claudePrimitiveEnable(kind, name, scope),
		onSuccess: invalidate,
	});
}

/** Disable a store catalog entry in a target scope (inverse of enable). */
export function useDisablePrimitive() {
	const invalidate = useInvalidateClaudeStore();
	return useMutation<void, Error, { kind: ClaudeStoreKind; name: string; scope: ClaudeStoreScope }>(
		{
			mutationFn: ({ kind, name, scope }) => claudePrimitiveDisable(kind, name, scope),
			onSuccess: invalidate,
		}
	);
}

/** Copy a primitive from one scope to another, leaving the source in place. */
export function useCopyPrimitive() {
	const invalidate = useInvalidateClaudeStore();
	return useMutation<
		ClaudeStoreMutation,
		Error,
		{
			kind: ClaudeStoreKind;
			name: string;
			fromScope: ClaudeStoreScope;
			toScope: ClaudeStoreScope;
		}
	>({
		mutationFn: ({ kind, name, fromScope, toScope }) =>
			claudePrimitiveCopy(kind, name, fromScope, toScope),
		onSuccess: invalidate,
	});
}

/** Move a primitive from one scope to another (copy-then-remove-source). */
export function useMovePrimitive() {
	const invalidate = useInvalidateClaudeStore();
	return useMutation<
		ClaudeStoreMutation,
		Error,
		{
			kind: ClaudeStoreKind;
			name: string;
			fromScope: ClaudeStoreScope;
			toScope: ClaudeStoreScope;
		}
	>({
		mutationFn: ({ kind, name, fromScope, toScope }) =>
			claudePrimitiveMove(kind, name, fromScope, toScope),
		onSuccess: invalidate,
	});
}

/** Remove a primitive from a single scope's `.claude/` (scope-local delete). */
export function useRemovePrimitive() {
	const invalidate = useInvalidateClaudeStore();
	return useMutation<void, Error, { kind: ClaudeStoreKind; name: string; scope: ClaudeStoreScope }>(
		{
			mutationFn: ({ kind, name, scope }) => claudePrimitiveRemove(kind, name, scope),
			onSuccess: invalidate,
		}
	);
}

// ─── Ngwa v2b cross-system write hooks (WP-26 / D-09) ────────────────────────
//
// The per-ENGINE enable/disable + the cross-engine batch copy back the D-09
// drawer. They mirror the same invalidate pattern as the Phase-1 store hooks:
// each mutation invalidates the store catalog + the on-disk scan on success, so
// the engine-grouped facet live-refreshes. The per-engine writes target the
// frozen WP-22 `claude_primitive_enable_for` / `disable_for` commands; the batch
// copy targets WP-24's `claude_primitive_copy_batch` (mock-backed in tauri-cmd
// until WP-24 lands — see `NGWA_TRANSCODE_MOCK`).

/** Enable a settings-embedded primitive (hook/mcp) in a scope FOR A SPECIFIC
 *  ENGINE. Gemini strict-key rejection surfaces as an `NgwaStoreError` of kind
 *  `strictKeyRejected` (thrown before any disk write). `engine` defaults to
 *  `'claude'` so Phase-1 behaviour is preserved when omitted. */
export function useEnablePrimitiveFor() {
	const invalidate = useInvalidateClaudeStore();
	return useMutation<
		ClaudeStoreMutation,
		Error,
		{
			engine: EngineId;
			kind: ClaudeStoreKind;
			name: string;
			scope: ClaudeStoreScope;
			hookFile?: NgwaHookFile;
		}
	>({
		mutationFn: ({ engine, kind, name, scope, hookFile }) =>
			claudePrimitiveEnableFor(engine, kind, name, scope, hookFile ?? 'shared'),
		onSuccess: invalidate,
	});
}

/** Disable a settings-embedded primitive (hook/mcp) from a scope for a specific
 *  engine — inverse of {@link useEnablePrimitiveFor}. */
export function useDisablePrimitiveFor() {
	const invalidate = useInvalidateClaudeStore();
	return useMutation<
		void,
		Error,
		{
			engine: EngineId;
			kind: ClaudeStoreKind;
			name: string;
			scope: ClaudeStoreScope;
			hookFile?: NgwaHookFile;
		}
	>({
		mutationFn: ({ engine, kind, name, scope, hookFile }) =>
			claudePrimitiveDisableFor(engine, kind, name, scope, hookFile ?? 'shared'),
		onSuccess: invalidate,
	});
}

/** Cross-engine forward transcode copy/move into N (engine, scope) destinations
 *  in one batch — the D-09 "Copy to N" action. Resolves to a per-row batch
 *  result (`NgwaCopyBatchResult`); the drawer renders partial failures inline.
 *  Invalidates on settle (not just success) so the scan refreshes even when some
 *  rows fail — a partial success still changed the disk for the rows that wrote.
 *
 *  MOCK SEAM: `ngwaCrossEngineCopy` is mock-backed until WP-24 (see tauri-cmd
 *  `NGWA_TRANSCODE_MOCK`); this hook is finalized against the real command then. */
export function useCrossEngineCopy() {
	const invalidate = useInvalidateClaudeStore();
	return useMutation<
		NgwaCopyBatchResult,
		Error,
		{
			fromEngine: EngineId;
			kind: ClaudeStoreKind;
			name: string;
			fromScope: ClaudeStoreScope;
			destinations: NgwaCopyDestination[];
			move?: boolean;
		}
	>({
		mutationFn: ({ fromEngine, kind, name, fromScope, destinations, move }) =>
			ngwaCrossEngineCopy(fromEngine, kind, name, fromScope, destinations, move ?? false),
		onSettled: () => invalidate(),
	});
}
