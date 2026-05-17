// Small reusable atoms for the v2 pkg surface.
//
// Chips render the state-led metadata each row carries (running, idle,
// disabled, update-available, trust-review-pending, has-violation). The
// PkgIcon block applies the workspace tint hue from `--tint-bg-active`.

import { AlertTriangle, ArrowUp, Circle, Shield } from 'lucide-react';
import type { PkgRowV2, RowState } from '@/lib/pkgs/use-derived';
import { cn } from '@/components/ui/utils';

/* ───── State pill ───── */
export function StateChip({ state }: { state: RowState }) {
	if (state === 'running') {
		return (
			<span className="inline-flex items-center gap-1 rounded-sm border border-emerald-500/30 bg-emerald-500/15 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-emerald-500">
				<span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
				running
			</span>
		);
	}
	if (state === 'idle') {
		return (
			<span className="inline-flex items-center gap-1 rounded-sm border border-border bg-background px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
				<span className="h-1.5 w-1.5 rounded-full bg-muted-foreground" />
				idle
			</span>
		);
	}
	if (state === 'disabled') {
		return (
			<span className="inline-flex items-center gap-1 rounded-sm border border-border bg-background px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground/70">
				<span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/70" />
				disabled
			</span>
		);
	}
	return (
		<span className="inline-flex items-center gap-1 rounded-sm border border-dashed border-border bg-transparent px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground/70">
			<span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/70" />
			not installed
		</span>
	);
}

export function UpdateChip({ row }: { row: PkgRowV2 }) {
	if (!row.latest || row.latest === row.version || row.origin === 'registry') return null;
	return (
		<span className="inline-flex items-center gap-1 rounded-sm border border-amber-500/40 bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-amber-600 dark:text-amber-400">
			<ArrowUp className="h-3 w-3" />v{row.latest} available
		</span>
	);
}

export function TrustChip({ row }: { row: PkgRowV2 }) {
	if (row.trust?.state !== 'needs_approval') return null;
	return (
		<span className="inline-flex items-center gap-1 rounded-sm border border-red-500/40 bg-red-500/15 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-red-500">
			<Shield className="h-3 w-3" />
			trust review
		</span>
	);
}

export function ViolationChip({ row }: { row: PkgRowV2 }) {
	if (!row.violations.length) return null;
	return (
		<span className="inline-flex items-center gap-1 rounded-sm border border-red-500/40 bg-red-500/15 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-red-500">
			<AlertTriangle className="h-3 w-3" />
			denied perm
		</span>
	);
}

export function OriginChip({ origin }: { origin: PkgRowV2['origin'] }) {
	const map: Record<PkgRowV2['origin'], { label: string; cls: string }> = {
		builtin: {
			label: 'built-in',
			cls: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-600 dark:text-cyan-400',
		},
		engine: {
			label: 'engine',
			cls: 'border-primary/30 bg-primary/10 text-primary',
		},
		registry: {
			label: 'registry',
			cls: 'border-dashed border-border text-muted-foreground',
		},
		user: {
			label: 'user',
			cls: 'border-border text-muted-foreground',
		},
	};
	const { label, cls } = map[origin];
	return (
		<span
			className={cn(
				'inline-flex items-center rounded-sm border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide',
				cls
			)}
		>
			{label}
		</span>
	);
}

/* ───── Generic dot (used in trust log) ───── */
export function Dot({ tone = 'muted' }: { tone?: 'muted' | 'live' | 'warn' | 'danger' }) {
	const cls =
		tone === 'live'
			? 'bg-emerald-500'
			: tone === 'warn'
				? 'bg-amber-500'
				: tone === 'danger'
					? 'bg-red-500'
					: 'bg-muted-foreground';
	return <span className={cn('inline-block h-2 w-2 rounded-full', cls)} />;
}

export { Circle };
