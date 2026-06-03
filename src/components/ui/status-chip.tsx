import type * as React from 'react';
import type { LucideIcon } from 'lucide-react';

import { cn } from '@/components/ui/utils';

// Shared status chip — the one pill the chrome's state/metadata markers render
// through (pkg-store StateChip/Update/Trust/Violation/Origin, chat event-kind
// labels, …). One shape: a mono uppercase pill with an optional leading dot or
// icon. Tone → semantic token, killing the hardcoded emerald-500/amber-500/
// red-500/cyan-500 bypass that lived in pkg/v2/atoms.tsx.
//
// Spec: plans/shell-design-system/parts/components/status-chip.md
//       + designs/status-chip.html (the locked Dusk Wood mockup).

export type ChipTone = 'muted' | 'faint' | 'live' | 'warn' | 'danger' | 'info' | 'accent';

const TONE_FG: Record<ChipTone, string> = {
	muted: 'var(--fg-muted)',
	faint: 'var(--fg-faint)',
	live: 'var(--live)',
	warn: 'var(--achievement)',
	danger: 'var(--danger)',
	info: 'var(--systemic)',
	accent: 'var(--primary)',
};

function chipStyle(tone: ChipTone): React.CSSProperties {
	const fg = TONE_FG[tone];
	const neutral = tone === 'muted' || tone === 'faint';
	return {
		color: fg,
		borderColor: neutral ? 'var(--border)' : `color-mix(in srgb, ${fg} 35%, transparent)`,
		background: neutral ? 'var(--bg-base)' : `color-mix(in srgb, ${fg} 15%, transparent)`,
	};
}

export interface StatusChipProps {
	tone?: ChipTone;
	/** Leading lucide icon (mutually exclusive with `dot`). */
	icon?: LucideIcon;
	/** Show a leading colour dot instead of an icon. */
	dot?: boolean;
	/** Dashed border (not-installed / registry contexts). */
	dashed?: boolean;
	className?: string;
	children: React.ReactNode;
}

export function StatusChip({
	tone = 'muted',
	icon: Icon,
	dot = false,
	dashed = false,
	className,
	children,
}: StatusChipProps) {
	const fg = TONE_FG[tone];
	return (
		<span
			className={cn(
				'inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide',
				dashed && 'border-dashed',
				className
			)}
			style={chipStyle(tone)}
		>
			{dot && (
				<span
					className="h-1.5 w-1.5 shrink-0 rounded-full"
					style={{ background: fg }}
					aria-hidden
				/>
			)}
			{Icon && <Icon className="h-3 w-3 shrink-0" aria-hidden />}
			{children}
		</span>
	);
}

/** Standalone tone dot (the trust-log marker). */
export function StatusDot({ tone = 'muted' }: { tone?: ChipTone }) {
	return (
		<span
			className="inline-block h-2 w-2 rounded-full"
			style={{ background: TONE_FG[tone] }}
			aria-hidden
		/>
	);
}
