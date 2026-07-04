// Settings → Data health (Atelier/PA domain soft-FK orphan audit).
//
// The `0025`–`0054` migrations are the SQLite down-map of the old `royalti-pa`
// Supabase schema and declare **zero** FOREIGN KEY constraints — every
// cross-domain relationship is a plain TEXT "soft link" resolved at query time
// (see the migration-header comments, e.g. `0025_tasks_domain.sql:18`). Nothing
// in the schema stops a parent row from being deleted out from under a child
// that points at it, so a dangling `research_item_id` sits silently until
// something queries it.
//
// This panel mirrors the pkg-health-panel.tsx precedent: a read-only scan that
// *surfaces* orphaned soft-linked rows and leaves the fix to a human. Unlike
// pkg-health it offers NO remove action — these are real business records (a
// stray deal, a task) the user may want to repair, not install metadata to
// purge. Decision doc: `plans/atelier-parity/07-fk-orphan-audit.md` (Option B).
//
// Sibling to pkg-health-panel.tsx / pkg-violations-audit.tsx under the
// diagnostics surfaces.

import { AlertTriangle, CheckCircle2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FeedbackState } from '@/components/ui/feedback-state';
import { dataHealthScan, type OrphanReport } from '@/lib/tauri-cmd';
import { useQuery } from '@tanstack/react-query';

export function DataHealthPanel() {
	const scanQuery = useQuery({
		queryKey: ['data', 'health'],
		queryFn: () => dataHealthScan(),
		refetchOnWindowFocus: true,
	});

	const rows: OrphanReport[] = scanQuery.data ?? [];
	const totalOrphans = rows.reduce((n, r) => n + r.orphan_count, 0);

	return (
		<div className="space-y-6 p-6">
			<div className="flex items-center justify-between">
				<div>
					<h2 className="font-display text-base font-semibold">
						Data health
						{rows.length > 0 && (
							<span className="ml-2 rounded-sm border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 font-mono text-[11px] text-amber-600 dark:text-amber-400">
								{totalOrphans}
							</span>
						)}
					</h2>
					<p className="mt-0.5 max-w-prose text-[11.5px] text-muted-foreground">
						Dangling soft-links in the domain tables. The Atelier/PA migrations declare no
						foreign keys — cross-domain references are plain TEXT "soft links", so deleting a
						parent row can silently strand a child that pointed at it. This scan only reads;
						it never deletes. These are real records (a deal, a task, a content piece) — repair
						or clear the reference in the owning app rather than removing the row here.
					</p>
				</div>
				<div className="flex shrink-0 items-center gap-1.5">
					<Button
						size="sm"
						variant="ghost"
						disabled={scanQuery.isFetching}
						onClick={() => scanQuery.refetch()}
						aria-label="Re-scan data health"
					>
						<RefreshCw className={`h-3.5 w-3.5 ${scanQuery.isFetching ? 'animate-spin' : ''}`} />
					</Button>
				</div>
			</div>

			{scanQuery.isLoading && (
				<FeedbackState variant="loading" heading="Scanning soft-links…" />
			)}
			{scanQuery.error && (
				<FeedbackState
					variant="error"
					heading="Data-health scan failed"
					body={(scanQuery.error as Error).message}
				/>
			)}
			{!scanQuery.isLoading && !scanQuery.error && rows.length === 0 && (
				<FeedbackState
					variant="empty"
					icon={CheckCircle2}
					heading="No orphaned references."
					body="Every audited soft-link resolves to a live parent row."
				/>
			)}

			{rows.length > 0 && (
				<div className="overflow-hidden rounded-sm border border-border">
					<table className="w-full text-xs">
						<thead>
							<tr className="border-b border-border bg-muted/40">
								<th className="px-3 py-2 text-left font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
									link
								</th>
								<th className="px-3 py-2 text-left font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
									status
								</th>
								<th className="px-3 py-2 text-right font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
									orphans
								</th>
								<th className="px-3 py-2 text-left font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
									sample record ids
								</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-border">
							{rows.map((r) => (
								<tr
									key={`${r.table}.${r.column}`}
									className="bg-background align-top hover:bg-muted/20"
								>
									<td className="px-3 py-2">
										<div className="font-mono text-[11px] text-foreground">
											{r.table}.{r.column}
										</div>
										<div className="font-mono text-[10px] text-muted-foreground/70">
											→ {r.parent_table}.id
										</div>
									</td>
									<td className="px-3 py-2">
										<span className="inline-flex items-center gap-1 rounded-sm border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 font-mono text-[10px] uppercase text-amber-600 dark:text-amber-400">
											<AlertTriangle className="h-3 w-3" />
											dangling
										</span>
									</td>
									<td className="px-3 py-2 text-right font-mono text-[11px] text-foreground">
										{r.orphan_count}
									</td>
									<td className="px-3 py-2">
										<div className="flex flex-wrap gap-1">
											{r.sample_ids.map((id) => (
												<code
													key={id}
													className="rounded-sm border border-border bg-muted/40 px-1.5 py-0.5 text-[10px] text-muted-foreground"
												>
													{id}
												</code>
											))}
											{r.orphan_count > r.sample_ids.length && (
												<span className="px-1 py-0.5 text-[10px] text-muted-foreground/60">
													+{r.orphan_count - r.sample_ids.length} more
												</span>
											)}
										</div>
									</td>
								</tr>
							))}
						</tbody>
					</table>
					<div className="border-t border-border bg-muted/20 px-3 py-2 font-mono text-[10px] text-muted-foreground/70">
						{rows.length} soft-link{rows.length === 1 ? '' : 's'} with dangling references (
						{totalOrphans} row{totalOrphans === 1 ? '' : 's'} total). Open each record in its
						owning app to repair or clear the reference — nothing is deleted here.
					</div>
				</div>
			)}
		</div>
	);
}
