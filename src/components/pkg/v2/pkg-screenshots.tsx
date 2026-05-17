// Pkg screenshot carousel — main image + caption + thumb strip.
// Used inside the loupe Overview tab and (preview variant) inside the
// pkg-targeted install sheet.

import { useState } from 'react';
import { cn } from '@/components/ui/utils';
import type { PkgRowV2 } from '@/lib/pkgs/use-derived';
import { useScreenshotSrc } from './pkg-thumb';

export function PkgScreenshotCarousel({
	row,
	variant = 'loupe',
}: {
	row: PkgRowV2;
	variant?: 'loupe' | 'install-preview';
}) {
	const shots = row.screenshots;
	const [idx, setIdx] = useState(0);
	const activeRef = shots[idx] ?? null;
	const activeSrc = useScreenshotSrc(activeRef);

	if (!shots.length) {
		// No screenshots declared. Don't burn a huge placeholder on it — for
		// non-UI pkgs (engines / MCPs / skills) a single quiet line is enough.
		// Caller can also choose to skip rendering us by checking `row.screenshots`.
		return (
			<div className="font-mono text-[11px] tracking-wide text-muted-foreground/70">
				No screenshots — this pkg has no UI
			</div>
		);
	}

	const mainCls = variant === 'install-preview' ? 'aspect-[16/9.5]' : 'aspect-video';

	return (
		<section className="space-y-2">
			<SectionLabel>
				screenshots · {shots.length}
				{variant === 'install-preview' && ' · what you’ll get'}
			</SectionLabel>
			<div
				className={cn('rounded-sm border border-border bg-background bg-cover bg-center', mainCls)}
				style={activeSrc ? { backgroundImage: `url(${activeSrc})` } : undefined}
			/>
			{activeRef?.caption && (
				<div className="font-mono text-[11px] tracking-wide text-muted-foreground">
					{activeRef.caption}
				</div>
			)}
			{shots.length > 1 && (
				<div className="flex gap-1.5 overflow-x-auto">
					{shots.map((_shot, i) => (
						<ShotThumb
							key={i}
							row={row}
							shotIndex={i}
							active={i === idx}
							onClick={() => setIdx(i)}
						/>
					))}
				</div>
			)}
		</section>
	);
}

/**
 * Hero band rendered above the loupe head. Falls back to a tinted empty band
 * for pkgs without screenshots so the head still has a coherent top edge.
 */
export function PkgScreenshotHero({ row }: { row: PkgRowV2 }) {
	const first = row.screenshots[0] ?? null;
	const src = useScreenshotSrc(first);
	// No screenshot → skip the hero entirely. The loupe head still anchors the
	// pkg identity; a giant grey band would just steal vertical space without
	// adding any signal.
	if (!src) return null;
	return (
		<div
			className="relative h-[140px] w-full border-b border-border bg-cover bg-center"
			style={{ backgroundImage: `url(${src})` }}
		>
			<div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-background" />
		</div>
	);
}

function ShotThumb({
	row,
	shotIndex,
	active,
	onClick,
}: {
	row: PkgRowV2;
	shotIndex: number;
	active: boolean;
	onClick: () => void;
}) {
	const ref = row.screenshots[shotIndex];
	const src = useScreenshotSrc(ref);
	return (
		<button
			type="button"
			onClick={onClick}
			title={ref?.caption ?? ''}
			className={cn(
				'h-10 w-16 shrink-0 rounded-[3px] border bg-background bg-cover bg-center transition-transform hover:-translate-y-px',
				active ? 'border-primary shadow-[0_0_0_1px_var(--primary)]' : 'border-border'
			)}
			style={src ? { backgroundImage: `url(${src})` } : undefined}
		/>
	);
}

function SectionLabel({ children }: { children: React.ReactNode }) {
	return (
		<div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
			{children}
		</div>
	);
}
