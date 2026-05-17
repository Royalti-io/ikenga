// Pkg row (medium variant) used by the catalog body across v2 surfaces.
// Clicking the row opens the loupe (handled by parent via onOpen).

import { ArrowUp, ExternalLink, Plus, Settings, Shield } from 'lucide-react';
import type { MouseEvent } from 'react';
import type { PkgRowV2 } from '@/lib/pkgs/use-derived';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/utils';
import { StateChip, TrustChip, UpdateChip, ViolationChip } from './atoms';
import { PkgThumb } from './pkg-thumb';

export interface PkgRowProps {
	row: PkgRowV2;
	onOpen: (row: PkgRowV2) => void;
	onInstall?: (row: PkgRowV2) => void;
	onUpdate?: (row: PkgRowV2) => void;
	onReviewTrust?: (row: PkgRowV2) => void;
}

export function PkgRow({ row, onOpen, onInstall, onUpdate, onReviewTrust }: PkgRowProps) {
	const isRegistry = row.origin === 'registry';
	const isOutdated = !!row.latest && row.latest !== row.version && !isRegistry;
	const needsTrust = row.trust?.state === 'needs_approval';

	const stopThenRun = (fn?: (row: PkgRowV2) => void) => (e: MouseEvent) => {
		e.stopPropagation();
		fn?.(row);
	};

	return (
		<div
			onClick={() => onOpen(row)}
			className={cn(
				'group grid cursor-pointer grid-cols-[88px_1fr_auto] items-center gap-4 rounded-md border bg-card px-3 py-2 transition-colors hover:bg-accent',
				isRegistry && 'border-dashed bg-transparent hover:bg-accent/40',
				isOutdated && 'border-amber-500/30',
				(needsTrust || row.violations.length > 0) && 'border-red-500/30',
				!row.enabled && row.origin !== 'registry' && 'opacity-60'
			)}
			data-pkg-id={row.id}
		>
			<PkgThumb row={row} />

			<div className="min-w-0 space-y-0.5">
				<div className="flex flex-wrap items-baseline gap-2">
					<span className="font-display text-base font-medium leading-tight text-foreground">
						{row.name}
					</span>
					<span className="rounded-sm border border-border bg-background px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
						v{row.version}
					</span>
					<StateChip state={row.state} />
					<UpdateChip row={row} />
					<TrustChip row={row} />
					<ViolationChip row={row} />
					<span className="truncate font-mono text-[11px] tracking-wide text-muted-foreground/70">
						{row.id}
					</span>
				</div>
				{row.desc && <div className="text-xs leading-snug text-muted-foreground">{row.desc}</div>}
			</div>

			<div className="flex shrink-0 items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
				{isRegistry ? (
					<Button size="sm" className="h-7 gap-1.5" onClick={stopThenRun(onInstall)}>
						<Plus className="h-3.5 w-3.5" />
						Install
					</Button>
				) : isOutdated ? (
					<>
						<Button
							size="sm"
							variant="outline"
							className="h-7 gap-1.5 border-amber-500/40 text-amber-600 hover:bg-amber-500/10 dark:text-amber-400"
							onClick={stopThenRun(onUpdate)}
						>
							<ArrowUp className="h-3.5 w-3.5" />
							Update
						</Button>
						<Button
							size="sm"
							variant="ghost"
							className="h-7 w-7 px-0"
							onClick={stopThenRun(onOpen)}
							title="Open detail"
						>
							<ExternalLink className="h-3.5 w-3.5" />
						</Button>
					</>
				) : needsTrust ? (
					<Button
						size="sm"
						variant="outline"
						className="h-7 gap-1.5 border-red-500/40 text-red-500 hover:bg-red-500/10"
						onClick={stopThenRun(onReviewTrust)}
					>
						<Shield className="h-3.5 w-3.5" />
						Review
					</Button>
				) : (
					<>
						<Button size="sm" variant="ghost" className="h-7 gap-1.5" onClick={stopThenRun(onOpen)}>
							<ExternalLink className="h-3.5 w-3.5" />
							Open
						</Button>
						<Button
							size="sm"
							variant="ghost"
							className="h-7 w-7 px-0"
							onClick={stopThenRun(onOpen)}
							title="Configure"
						>
							<Settings className="h-3.5 w-3.5" />
						</Button>
					</>
				)}
			</div>
		</div>
	);
}

export function PkgGroup({
	label,
	rows,
	onOpen,
	onInstall,
	onUpdate,
	onReviewTrust,
}: {
	label: string;
	rows: PkgRowV2[];
	onOpen: (row: PkgRowV2) => void;
	onInstall?: (row: PkgRowV2) => void;
	onUpdate?: (row: PkgRowV2) => void;
	onReviewTrust?: (row: PkgRowV2) => void;
}) {
	if (!rows.length) return null;
	return (
		<div className="space-y-1.5">
			<div className="mb-2 flex items-center gap-3">
				<span className="font-mono text-[10.5px] uppercase tracking-wider text-muted-foreground/70">
					{label}
				</span>
				<span className="h-px flex-1 bg-border" />
				<span className="font-mono text-[10px] text-muted-foreground">{rows.length}</span>
			</div>
			{rows.map((row) => (
				<PkgRow
					key={row.id}
					row={row}
					onOpen={onOpen}
					onInstall={onInstall}
					onUpdate={onUpdate}
					onReviewTrust={onReviewTrust}
				/>
			))}
		</div>
	);
}
