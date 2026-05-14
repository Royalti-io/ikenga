import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';

import {
	type VaultScope,
	type VaultStatus,
	secretsDelete,
	secretsDeleteScoped,
	secretsListKeys,
	secretsListKeysScoped,
	secretsSet,
	secretsSetScoped,
	secretsVaultStatus,
} from '@/lib/tauri-cmd';
import { queryKeys } from '@/lib/query-keys';

export type { VaultStatus };

export function vaultStatusQueryOptions() {
	return queryOptions({
		queryKey: queryKeys.secrets.vaultStatus(),
		queryFn: () => secretsVaultStatus(),
		staleTime: 30_000,
	});
}

export function vaultKeysQueryOptions() {
	return queryOptions({
		queryKey: queryKeys.secrets.keys(),
		queryFn: () => secretsListKeys(),
		staleTime: 5_000,
	});
}

export function useSetSecret() {
	const qc = useQueryClient();
	return useMutation<void, Error, { key: string; value: string }>({
		mutationFn: ({ key, value }) => secretsSet(key, value),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: queryKeys.secrets.all });
		},
	});
}

export function useDeleteSecret() {
	const qc = useQueryClient();
	return useMutation<void, Error, string>({
		mutationFn: (key) => secretsDelete(key),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: queryKeys.secrets.all });
		},
	});
}

// ─── Phase 7 — scoped variants ────────────────────────────────────────────

function scopeKey(scope: VaultScope): string {
	return scope.kind === 'workspace' ? 'workspace' : `${scope.kind}:${scope.id}`;
}

export function vaultKeysScopedQueryOptions(scope: VaultScope) {
	return queryOptions({
		queryKey: [...queryKeys.secrets.all, 'scoped', scopeKey(scope)] as const,
		queryFn: () => secretsListKeysScoped(scope),
		staleTime: 5_000,
	});
}

export function useSetScopedSecret() {
	const qc = useQueryClient();
	return useMutation<void, Error, { scope: VaultScope; key: string; value: string }>({
		mutationFn: ({ scope, key, value }) => secretsSetScoped(scope, key, value),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: queryKeys.secrets.all });
		},
	});
}

export function useDeleteScopedSecret() {
	const qc = useQueryClient();
	return useMutation<void, Error, { scope: VaultScope; key: string }>({
		mutationFn: ({ scope, key }) => secretsDeleteScoped(scope, key),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: queryKeys.secrets.all });
		},
	});
}
