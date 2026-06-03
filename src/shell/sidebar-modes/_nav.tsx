import type * as React from 'react';
import type { LucideIcon } from 'lucide-react';

import { cn } from '@/components/ui/utils';
import { type ChipTone, StatusChip } from '@/components/ui/status-chip';

// Shared sidebar nav vocabulary — the section-header + nav-row the activity-mode
// sidebars render through. Consolidates the duplicated hand-rolled implementations
// across app / settings / pkgs / pkg modes into one, standardising the (drifted)
// section-header style and adding the missing focus-visible ring + aria-current.
// The count badge routes to semantic tokens (--achievement / --danger), killing
// the hardcoded amber-500/red-500 bypass that lived in pkgs-mode.
//
// Spec: plans/shell-design-system/parts/components/sidebar-nav-list.md
//       + designs/sidebar-nav-list.html (the locked Dusk Wood mockup).
// (ngwa-mode keeps its .ngwa-* claude-config idiom; artifact-grid-mode keeps its
//  list-row RecentRows — those are different row archetypes, intentionally local.)

export function SidebarNav({
	children,
	ariaLabel,
}: {
	children: React.ReactNode;
	ariaLabel?: string;
}) {
	return (
		<nav className="h-full overflow-y-auto py-2" aria-label={ariaLabel}>
			{children}
		</nav>
	);
}

export function SidebarNavSection({
	label,
	children,
	className,
}: {
	label?: string;
	children: React.ReactNode;
	className?: string;
}) {
	return (
		<div className={cn('mb-3', className)} role="group" aria-label={label}>
			{label && (
				<div className="px-4 pb-1 pt-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
					{label}
				</div>
			)}
			<ul className="flex flex-col">{children}</ul>
		</div>
	);
}

export type SidebarNavBadgeTone = 'default' | 'attention' | 'warn';

export interface SidebarNavRowProps {
	icon?: LucideIcon;
	label: string;
	active?: boolean;
	disabled?: boolean;
	/** Numeric count badge (3 tones; hidden when 0). */
	count?: number;
	tone?: SidebarNavBadgeTone;
	/** Free-form string/number pill badge (pkg runtime menus). */
	badge?: string | number | null;
	onSelect?: () => void;
}

export function SidebarNavRow({
	icon: Icon,
	label,
	active = false,
	disabled = false,
	count,
	tone = 'default',
	badge,
	onSelect,
}: SidebarNavRowProps) {
	const showCount = typeof count === 'number' && count > 0;
	return (
		<li>
			<button
				type="button"
				disabled={disabled}
				aria-disabled={disabled || undefined}
				aria-current={active ? 'page' : undefined}
				onClick={disabled ? undefined : onSelect}
				className={cn(
					'flex w-full items-center gap-3 px-4 py-1.5 text-left text-sm transition-colors motion-reduce:transition-none',
					'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
					'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
					active && 'bg-accent font-medium text-accent-foreground',
					disabled && 'pointer-events-none opacity-40 hover:bg-transparent'
				)}
			>
				{Icon && <Icon className="h-4 w-4 shrink-0" />}
				<span className="flex-1 truncate">{label}</span>
				{showCount && <SidebarNavCount count={count} tone={tone} />}
				{badge != null && badge !== '' && (
					<span className="ml-auto rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium">
						{badge}
					</span>
				)}
			</button>
		</li>
	);
}

// Count badge folds onto the shared StatusChip — pkgs-mode's attention/warn
// tones map to the chip's warn (--achievement) / danger (--danger).
const COUNT_TO_CHIP: Record<SidebarNavBadgeTone, ChipTone> = {
	default: 'muted',
	attention: 'warn',
	warn: 'danger',
};

function SidebarNavCount({ count, tone }: { count: number; tone: SidebarNavBadgeTone }) {
	return <StatusChip tone={COUNT_TO_CHIP[tone]}>{count}</StatusChip>;
}
