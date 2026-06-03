// Small reusable atoms for the v2 pkg surface.
//
// Chips render the state-led metadata each row carries (running, idle,
// disabled, update-available, trust-review-pending, has-violation). They are
// thin wrappers over the shared <StatusChip> (components/ui/status-chip) so the
// pill shape + tone tokens stay single-sourced — no more hardcoded
// emerald/amber/red/cyan per chip.

import { AlertTriangle, ArrowUp, Circle, Shield } from 'lucide-react';
import type { PkgRowV2, RowState } from '@/lib/pkgs/use-derived';
import { type ChipTone, StatusChip, StatusDot } from '@/components/ui/status-chip';

/* ───── State pill ───── */
export function StateChip({ state }: { state: RowState }) {
	if (state === 'running')
		return (
			<StatusChip tone="live" dot>
				running
			</StatusChip>
		);
	if (state === 'idle')
		return (
			<StatusChip tone="muted" dot>
				idle
			</StatusChip>
		);
	if (state === 'disabled')
		return (
			<StatusChip tone="faint" dot>
				disabled
			</StatusChip>
		);
	return (
		<StatusChip tone="faint" dot dashed>
			not installed
		</StatusChip>
	);
}

export function UpdateChip({ row }: { row: PkgRowV2 }) {
	if (!row.latest || row.latest === row.version || row.origin === 'registry') return null;
	return (
		<StatusChip tone="warn" icon={ArrowUp}>
			v{row.latest} available
		</StatusChip>
	);
}

export function TrustChip({ row }: { row: PkgRowV2 }) {
	if (row.trust?.state !== 'needs_approval') return null;
	return (
		<StatusChip tone="danger" icon={Shield}>
			trust review
		</StatusChip>
	);
}

export function ViolationChip({ row }: { row: PkgRowV2 }) {
	if (!row.violations.length) return null;
	return (
		<StatusChip tone="danger" icon={AlertTriangle}>
			denied perm
		</StatusChip>
	);
}

const ORIGIN: Record<PkgRowV2['origin'], { label: string; tone: ChipTone; dashed?: boolean }> = {
	builtin: { label: 'built-in', tone: 'info' },
	engine: { label: 'engine', tone: 'accent' },
	registry: { label: 'registry', tone: 'muted', dashed: true },
	user: { label: 'user', tone: 'muted' },
};

export function OriginChip({ origin }: { origin: PkgRowV2['origin'] }) {
	const { label, tone, dashed } = ORIGIN[origin];
	return (
		<StatusChip tone={tone} dashed={dashed}>
			{label}
		</StatusChip>
	);
}

/* ───── Generic dot (used in trust log) ───── */
export function Dot({ tone = 'muted' }: { tone?: 'muted' | 'live' | 'warn' | 'danger' }) {
	return <StatusDot tone={tone} />;
}

export { Circle };
