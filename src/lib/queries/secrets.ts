import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';

import {
	type VaultStatus,
	secretsDelete,
	secretsListKeys,
	secretsSet,
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

