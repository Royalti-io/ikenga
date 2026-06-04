// Renders the SidecarSupervisor's per-pkg status via the shared StatusChip
// (semantic tones — warn for the operator-fixable Blocked case, e.g.
// port-in-use); Restart button kicks the supervisor for any non-running entry.

import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';

import { pkgKernelStatus, pkgSupervisorRestart } from '@/lib/tauri-cmd';
import { StatusChip, type ChipTone } from '@/components/ui/status-chip';

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

// Supervisor state → the shared StatusChip tone vocabulary (semantic tokens,
// not hardcoded green/yellow/orange/red). running=live, blocked=warn (the
// operator-fixable case), crashed/parked=danger (the label text disambiguates
// the two non-recoverable states), spawning/unknown=muted.
function stateTone(state: string): ChipTone {
	switch (state) {
		case 'running':
			return 'live';
		case 'blocked':
			return 'warn';
		case 'crashed':
		case 'parked':
			return 'danger';
		default:
			return 'muted';
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

	if (isLoading) return <div className="text-sm text-muted-foreground">loading kernel status…</div>;
	if (error) return <div className="text-sm text-destructive">error: {String(error)}</div>;

	const supervisor = (data?.registries?.sidecar_supervisor ?? {}) as SidecarSnapshot;
	const entries = supervisor.entries ?? [];

	if (entries.length === 0) {
		return <div className="text-sm text-muted-foreground">no supervised sidecars</div>;
	}

	return (
		<div className="space-y-2">
			{entries.map((e) => {
				const restartable = e.state !== 'running' && e.state !== 'spawning';
				return (
					<div
						key={e.pkg_id}
						className="flex items-center justify-between rounded-md border border-border px-3 py-2"
						data-pkg-id={e.pkg_id}
						data-state={e.state}
					>
						<div className="flex items-center gap-3">
							<StatusChip tone={stateTone(e.state)}>
								{e.state === 'blocked' && e.last_err ? `Blocked: ${e.last_err}` : e.state}
							</StatusChip>
							<span className="font-mono text-sm">{e.pkg_id}</span>
							{e.pid !== null && <span className="text-xs text-muted-foreground">pid {e.pid}</span>}
							{e.uptime_s !== null && (
								<span className="text-xs text-muted-foreground">{e.uptime_s}s</span>
							)}
							{e.state !== 'blocked' && e.last_err && (
								<span className="text-xs text-muted-foreground">{e.last_err}</span>
							)}
						</div>
						{restartable && (
							<button
								type="button"
								onClick={() => restart.mutate(e.pkg_id)}
								disabled={restart.isPending}
								className="rounded border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
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
