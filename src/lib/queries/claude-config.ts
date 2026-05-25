import { useEffect } from 'react';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';

import {
	claudeConfigListen,
	claudeConfigLoad,
	claudeConfigUnwatch,
	claudeConfigWatch,
	claudePrimitiveCopy,
	claudePrimitiveDisable,
	claudePrimitiveEnable,
	claudePrimitiveMove,
	claudePrimitiveRemove,
	claudeStoreImport,
	claudeStoreList,
	type ClaudeConfig,
	type ClaudeStoreEntry,
	type ClaudeStoreKind,
	type ClaudeStoreMutation,
	type ClaudeStoreScope,
} from '@/lib/tauri-cmd';
import { queryKeys } from '@/lib/query-keys';

export type { ClaudeConfig, ClaudeStoreEntry, ClaudeStoreKind, ClaudeStoreMutation, ClaudeStoreScope };

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
	return useMutation<
		void,
		Error,
		{ kind: ClaudeStoreKind; name: string; scope: ClaudeStoreScope }
	>({
		mutationFn: ({ kind, name, scope }) => claudePrimitiveDisable(kind, name, scope),
		onSuccess: invalidate,
	});
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
	return useMutation<
		void,
		Error,
		{ kind: ClaudeStoreKind; name: string; scope: ClaudeStoreScope }
	>({
		mutationFn: ({ kind, name, scope }) => claudePrimitiveRemove(kind, name, scope),
		onSuccess: invalidate,
	});
}
