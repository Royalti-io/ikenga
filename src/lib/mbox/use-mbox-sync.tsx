/**
 * Mbox sync hooks. Two surfaces share state via the React Query cache so the
 * scheduler and any UI consumers stay coordinated:
 *
 *  - useMboxSyncScheduler — mount EXACTLY ONCE at the app shell. Owns the
 *    30-min interval and runs an initial sync after a short startup delay.
 *  - useMboxSyncStatus — mount anywhere a UI surface needs the last-sync
 *    state or a manual "Sync now" button. Pure consumer; no interval.
 *
 * Cadence: 30 minutes. Replaces ikenga's external 4-hour cron — the
 * desktop app's "always on" assumption means we can poll more aggressively
 * without piling up costs.
 */

import { useCallback, useEffect, useRef } from 'react';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';

import { queryKeys } from '@/lib/query-keys';
import { runMboxSync, type SyncOpts, type SyncResult } from './sync';
import { readSyncState, type SyncState } from './sync-state';

const SYNC_INTERVAL_MS = 30 * 60 * 1000;
const STARTUP_DELAY_MS = 15 * 1000;

const LAST_RESULT_KEY = [...queryKeys.mbox.all, 'last-result'] as const;

function invalidateConsumers(qc: QueryClient): void {
  qc.invalidateQueries({ queryKey: queryKeys.mbox.all });
  qc.invalidateQueries({ queryKey: queryKeys.inbox.all });
  qc.invalidateQueries({ queryKey: queryKeys.triage.all });
}

function useSyncMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (opts: SyncOpts = {}) => runMboxSync(opts),
    onSuccess: (result) => {
      qc.setQueryData(LAST_RESULT_KEY, result);
      invalidateConsumers(qc);
    },
    onError: () => {
      qc.invalidateQueries({ queryKey: queryKeys.mbox.syncState() });
    },
  });
}

/**
 * Mount once at the app shell. Subsequent mounts will create extra intervals,
 * which would not corrupt anything (sync is idempotent) but would waste calls.
 */
export function useMboxSyncScheduler(): void {
  const mutation = useSyncMutation();
  const triggerRef = useRef<() => void>(() => {});
  triggerRef.current = () => {
    if (!mutation.isPending) {
      void mutation.mutateAsync({}).catch(() => {
        /* error already captured in cache via onError */
      });
    }
  };

  useEffect(() => {
    let cancelled = false;
    const initial = setTimeout(() => {
      if (!cancelled) triggerRef.current();
    }, STARTUP_DELAY_MS);
    const interval = setInterval(() => {
      if (!cancelled) triggerRef.current();
    }, SYNC_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearTimeout(initial);
      clearInterval(interval);
    };
  }, []);
}

export interface MboxSyncStatus {
  state: SyncState | undefined;
  isLoadingState: boolean;
  isSyncing: boolean;
  lastResult: SyncResult | null;
  lastError: string | null;
  triggerSync: (opts?: SyncOpts) => Promise<SyncResult | null>;
}

export function useMboxSyncStatus(): MboxSyncStatus {
  const qc = useQueryClient();
  const stateQuery = useQuery({
    queryKey: queryKeys.mbox.syncState(),
    queryFn: readSyncState,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const mutation = useSyncMutation();
  const lastResult = qc.getQueryData<SyncResult>(LAST_RESULT_KEY) ?? null;

  const triggerSync = useCallback(
    async (opts?: SyncOpts) => {
      try {
        return await mutation.mutateAsync(opts ?? {});
      } catch {
        return null;
      }
    },
    [mutation],
  );

  const transientError = mutation.error
    ? mutation.error instanceof Error
      ? mutation.error.message
      : String(mutation.error)
    : null;

  return {
    state: stateQuery.data,
    isLoadingState: stateQuery.isLoading,
    isSyncing: mutation.isPending,
    lastResult,
    lastError: transientError ?? stateQuery.data?.lastError ?? null,
    triggerSync,
  };
}
