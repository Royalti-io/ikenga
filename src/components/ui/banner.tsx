import * as React from 'react';
import { X } from 'lucide-react';

import { cn } from '@/components/ui/utils';

// Shared workspace-top banner — the single component the four banner sites
// (connector / trust-review / updater / pkg-auto-updater) render through.
// Consolidates the ×4 hand-built strips and kills the hardcoded amber/emerald
// token-bypass: tone colours resolve to semantic tokens only.
//
// Design system: plans/shell-design-system/parts/components/banner.md +
// designs/banner.html (the locked Dusk Wood mockup this implements). Tone is
// conveyed by icon + text, never colour alone (WCAG 1.4.1); the message stays
// at --fg for legibility while a soft tint + tone-coloured icon carry the tone.

export type BannerTone = 'info' | 'warning' | 'success' | 'danger';

// Per-tone token map. Warm Theme-A roles preferred for chrome (the cool base
// --warning/--success are the var() fallback for a non-Theme-A render).
// No hardcoded hex — every value is a semantic token or a color-mix over one.
const TONES: Record<BannerTone, { accent: string; bg: string; border: string }> = {
	info: {
		accent: 'var(--fg-muted)',
		bg: 'color-mix(in srgb, var(--bg-raised) 60%, transparent)',
		border: 'var(--border)',
	},
	warning: {
		accent: 'var(--achievement, var(--warning))',
		bg: 'var(--achievement-soft, color-mix(in srgb, var(--warning) 14%, transparent))',
		border: 'color-mix(in srgb, var(--achievement, var(--warning)) 35%, var(--border))',
	},
	success: {
		accent: 'var(--live)',
		bg: 'var(--live-soft, color-mix(in srgb, var(--live) 14%, transparent))',
		border: 'color-mix(in srgb, var(--live) 35%, var(--border))',
	},
	danger: {
		accent: 'var(--danger)',
		bg: 'var(--danger-soft, color-mix(in srgb, var(--danger) 12%, transparent))',
		border: 'color-mix(in srgb, var(--danger) 40%, var(--border))',
	},
};

export interface BannerProps extends Omit<React.ComponentProps<'div'>, 'role'> {
	tone?: BannerTone;
	/** Leading glyph (a bare lucide icon — Banner sizes + tone-colours it). */
	icon?: React.ReactNode;
	/** Right-aligned actions (CTA buttons, quiet links). */
	actions?: React.ReactNode;
	/** When provided, renders a dismiss × at 24×24 (WCAG 2.5.8). */
	onDismiss?: () => void;
	/** aria-label for the dismiss control. */
	dismissLabel?: string;
	/** Override the announced role (default: danger → alert, else status). */
	role?: 'status' | 'alert';
}

export function Banner({
	tone = 'info',
	icon,
	actions,
	onDismiss,
	dismissLabel = 'Dismiss',
	role,
	className,
	children,
	...rest
}: BannerProps) {
	const t = TONES[tone];
	return (
		<div
			data-slot="banner"
			data-tone={tone}
			role={role ?? (tone === 'danger' ? 'alert' : 'status')}
			className={cn(
				'flex items-center gap-3 border-b px-4 py-2 text-sm text-foreground',
				className
			)}
			style={
				{
					background: t.bg,
					borderColor: t.border,
					'--banner-accent': t.accent,
				} as React.CSSProperties
			}
			{...rest}
		>
			{icon && (
				<span
					aria-hidden="true"
					className="flex shrink-0 [&>svg]:size-4 [&>svg]:shrink-0"
					style={{ color: 'var(--banner-accent)' }}
				>
					{icon}
				</span>
			)}
			<div className="min-w-0 flex-1">{children}</div>
			{actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
			{onDismiss && (
				<button
					type="button"
					onClick={onDismiss}
					aria-label={dismissLabel}
					title={dismissLabel}
					className={cn(
						'inline-grid size-6 shrink-0 place-items-center rounded text-muted-foreground transition-colors',
						'outline-none hover:bg-accent hover:text-foreground',
						'focus-visible:ring-2 focus-visible:ring-[var(--banner-accent)]'
					)}
				>
					<X className="size-3.5" />
				</button>
			)}
		</div>
	);
}
