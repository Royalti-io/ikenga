// Renders the SidecarSupervisor's per-pkg status. Yellow Blocked badge for
// operator-fixable failures (today: port-in-use); Restart button kicks the
// supervisor for any non-running entry.

import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';

import { pkgKernelStatus, pkgSupervisorRestart } from '@/lib/tauri-cmd';

interface SidecarEntry {
  pkg_id: string;
  state: string;
  pid: number | null;
  uptime_s: number | null;
  restarts: number;
  last_crash_unix_ms: number | null;
  last_err: string | null;
}

interface SidecarSnapshot {
  count?: number;
  entries?: SidecarEntry[];
}

export const KERNEL_STATUS_QUERY_KEY = ['pkg-kernel-status'] as const;

function badgeClasses(state: string): string {
  switch (state) {
    case 'running':
      return 'bg-green-100 text-green-800 border-green-300';
    case 'blocked':
      return 'bg-yellow-100 text-yellow-800 border-yellow-300';
    case 'crashed':
      return 'bg-orange-100 text-orange-800 border-orange-300';
    case 'parked':
      return 'bg-red-100 text-red-800 border-red-300';
    default:
      return 'bg-gray-100 text-gray-700 border-gray-300';
  }
}

export function PkgKernelStatus() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: KERNEL_STATUS_QUERY_KEY,
    queryFn: pkgKernelStatus,
    refetchInterval: 2_000,
  });
  const restart = useMutation({
    mutationFn: (pkgId: string) => pkgSupervisorRestart(pkgId),
    onSettled: () => qc.invalidateQueries({ queryKey: KERNEL_STATUS_QUERY_KEY }),
  });

  if (isLoading) return <div className="text-sm text-gray-500">loading kernel status…</div>;
  if (error) return <div className="text-sm text-red-600">error: {String(error)}</div>;

  const supervisor = (data?.registries?.sidecar_supervisor ?? {}) as SidecarSnapshot;
  const entries = supervisor.entries ?? [];

  if (entries.length === 0) {
    return <div className="text-sm text-gray-500">no supervised sidecars</div>;
  }

  return (
    <div className="space-y-2">
      {entries.map((e) => {
        const restartable = e.state !== 'running' && e.state !== 'spawning';
        return (
          <div
            key={e.pkg_id}
            className="flex items-center justify-between rounded-md border border-gray-200 px-3 py-2"
            data-pkg-id={e.pkg_id}
            data-state={e.state}
          >
            <div className="flex items-center gap-3">
              <span
                className={`rounded-full border px-2 py-0.5 text-xs font-medium ${badgeClasses(
                  e.state,
                )}`}
              >
                {e.state === 'blocked' && e.last_err
                  ? `Blocked: ${e.last_err}`
                  : e.state}
              </span>
              <span className="font-mono text-sm">{e.pkg_id}</span>
              {e.pid !== null && (
                <span className="text-xs text-gray-500">pid {e.pid}</span>
              )}
              {e.uptime_s !== null && (
                <span className="text-xs text-gray-500">{e.uptime_s}s</span>
              )}
              {e.state !== 'blocked' && e.last_err && (
                <span className="text-xs text-gray-500">{e.last_err}</span>
              )}
            </div>
            {restartable && (
              <button
                type="button"
                onClick={() => restart.mutate(e.pkg_id)}
                disabled={restart.isPending}
                className="rounded border border-gray-300 px-2 py-1 text-xs hover:bg-gray-50 disabled:opacity-50"
              >
                Restart
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
