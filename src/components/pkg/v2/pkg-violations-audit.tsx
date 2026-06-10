// Settings → Packages → Violations audit view (ADR-017 / WP-08).
//
// Shows all recent `pkg_permission_violations` rows across all installed pkgs,
// newest first. The elevated-verb enforcement (host.fetch / host.invoke, WP-04
// / WP-05) writes denials here with scope_kind = 'http' / 'invoke', extending
// the existing 'shell.execute' scope the Phase-2 enforcement already writes.
//
// scope_kind is a free-text TEXT column (no CHECK constraint in migration
// 0020) — no new migration was needed to cover the ADR-017 scope kinds.
//
// The view is additive: it lives alongside the per-pkg violations section in
// TabPermissions (pkg-loupe.tsx) but surfaces the cross-pkg picture.

import { Ban, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FeedbackState } from '@/components/ui/feedback-state';
import { pkgPermissionViolationsClear, pkgPermissionViolationsList } from '@/lib/tauri-cmd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

/** Map scope_kind values to human-readable labels. Covers existing
 *  shell.execute (Phase-2 ACL) and the ADR-017 elevated verbs. */
function scopeLabel(kind: string): string {
	switch (kind) {
		case 'shell.execute':
			return 'spawn';
		case 'http':
			return 'host.fetch';
		case 'invoke':
			return 'host.invoke';
		case 'secrets':
			return 'secrets';
		default:
			return kind;
	}
}

function scopeTone(kind: string): 'http' | 'invoke' | 'shell' | 'other' {
	if (kind === 'http') return 'http';
	if (kind === 'invoke' || kind === 'shell.execute') return 'invoke';
	return 'other';
}

const TONE_CLASSES: Record<string, string> = {
	http: 'border-primary/30 bg-primary/10 text-primary',
	invoke: 'border-destructive/40 bg-destructive/10 text-destructive',
	other: 'border-border bg-muted/40 text-muted-foreground',
};

function ScopeKindBadge({ kind }: { kind: string }) {
	const tone = scopeTone(kind);
	return (
		<span
			className={`inline-block rounded-sm border px-1.5 py-0.5 font-mono text-[10px] uppercase ${TONE_CLASSES[tone] ?? TONE_CLASSES.other}`}
		>
			{scopeLabel(kind)}
		</span>
	);
}

export function PkgViolationsAudit() {
	const qc = useQueryClient();

	const violationsQuery = useQuery({
		queryKey: ['pkg', 'violations-audit'],
		queryFn: () => pkgPermissionViolationsList(undefined, 200),
		refetchOnWindowFocus: true,
	});

	const clearMut = useMutation({
		mutationFn: (pkgId: string) => pkgPermissionViolationsClear(pkgId),
		onSuccess: () => qc.invalidateQueries({ queryKey: ['pkg'] }),
	});

	const rows = violationsQuery.data ?? [];

	// Group rows by pkg_id for the "clear" action.
	const pkgIds = Array.from(new Set(rows.map((r) => r.pkg_id)));

	return (
		<div className="space-y-6 p-6">
			<div className="flex items-center justify-between">
				<div>
					<h2 className="font-display text-base font-semibold">Permission violations</h2>
					<p className="mt-0.5 text-[11.5px] text-muted-foreground">
						Audit log of denied elevated-capability and permission-check attempts across all
						installed pkgs. Writes occur when a pkg tries to use a host verb it wasn't granted
						(host.fetch, host.invoke, shell.execute, …).
					</p>
				</div>
				<Button
					size="sm"
					variant="ghost"
					className="shrink-0"
					disabled={violationsQuery.isFetching}
					onClick={() => violationsQuery.refetch()}
					aria-label="Refresh violations list"
				>
					<RefreshCw
						className={`h-3.5 w-3.5 ${violationsQuery.isFetching ? 'animate-spin' : ''}`}
					/>
				</Button>
			</div>

			{violationsQuery.isLoading && (
				<FeedbackState variant="loading" heading="Loading violations…" />
			)}
			{violationsQuery.error && (
				<FeedbackState
					variant="error"
					heading="Failed to load violations"
					body={(violationsQuery.error as Error).message}
				/>
			)}
			{!violationsQuery.isLoading && rows.length === 0 && (
				<FeedbackState variant="empty" heading="No violations recorded." />
			)}

			{rows.length > 0 && (
				<>
					{/* Per-pkg clear actions */}
					{pkgIds.length > 0 && (
						<div className="flex flex-wrap gap-1.5">
							{pkgIds.map((id) => (
								<button
									key={id}
									type="button"
									disabled={clearMut.isPending}
									onClick={() => clearMut.mutate(id)}
									className="flex items-center gap-1 rounded-sm border border-border bg-background px-2 py-0.5 font-mono text-[11px] text-muted-foreground hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
								>
									<Ban className="h-3 w-3" />
									Clear {id}
								</button>
							))}
						</div>
					)}

					<div className="overflow-hidden rounded-sm border border-border">
						<table className="w-full text-xs">
							<thead>
								<tr className="border-b border-border bg-muted/40">
									<th className="px-3 py-2 text-left font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
										pkg
									</th>
									<th className="px-3 py-2 text-left font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
										scope
									</th>
									<th className="px-3 py-2 text-left font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
										attempted
									</th>
									<th className="px-3 py-2 text-left font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
										declared
									</th>
									<th className="px-3 py-2 text-left font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
										when
									</th>
								</tr>
							</thead>
							<tbody className="divide-y divide-border">
								{rows.map((v) => (
									<tr key={v.id} className="bg-background hover:bg-muted/20">
										<td className="max-w-[140px] truncate px-3 py-2 font-mono text-[11px] text-muted-foreground">
											{v.pkg_id}
										</td>
										<td className="px-3 py-2">
											<ScopeKindBadge kind={v.scope_kind} />
										</td>
										<td className="max-w-[160px] truncate px-3 py-2 font-mono text-[11px] text-foreground">
											{v.attempted}
										</td>
										<td className="max-w-[140px] truncate px-3 py-2 font-mono text-[11px] text-muted-foreground">
											{v.declared || '—'}
										</td>
										<td className="whitespace-nowrap px-3 py-2 font-mono text-[11px] text-muted-foreground">
											{new Date(v.occurred_at).toISOString().slice(0, 19).replace('T', ' ')}
										</td>
									</tr>
								))}
							</tbody>
						</table>
						<div className="border-t border-border bg-muted/20 px-3 py-2 font-mono text-[10px] text-muted-foreground/70">
							Showing {rows.length} most recent violation{rows.length === 1 ? '' : 's'} (cap: 200
							rows). Rows are local audit data only — cleared on demand, never synced.
						</div>
					</div>
				</>
			)}
		</div>
	);
}
