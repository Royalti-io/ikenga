import { Command } from 'cmdk';
import type { LucideIcon } from 'lucide-react';
import type * as React from 'react';
import { cn } from '@/components/ui/utils';

/**
 * The keyboard-shortcut chip rendered at the trailing edge of a command row.
 * Extracted so palette / new-tab / dock surfaces share one recipe instead of
 * re-inlining the `<kbd>` markup (the old `[drift]`). Token-anchored
 * (`--muted` / `--border` / `--muted-foreground`); always `aria-hidden` when
 * the label already carries the accessible name.
 */
export function ShortcutChip({ className, children, ...props }: React.ComponentProps<'kbd'>) {
	return (
		<kbd
			className={cn(
				'shrink-0 rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground',
				className
			)}
			{...props}
		>
			{children}
		</kbd>
	);
}

export interface CommandRowProps {
	onSelect: () => void;
	Icon: LucideIcon;
	label: string;
	/** Rendered as a trailing `<kbd>`; `aria-hidden` (the label carries the name). */
	shortcut?: string;
	/** Muted trailing annotation (path, "(focused)", "streaming Claude", …). */
	detail?: string;
	disabled?: boolean;
	/** `md` = ⌘K palette (text-sm / icon 16). `sm` = new-tab + dock (text-xs / icon 14). */
	size?: 'md' | 'sm';
	/**
	 * `command-item` = cmdk `Command.Item` inside a `Command.List` (default).
	 * `menuitem` = `<button role="menuitem">` inside a `role="menu"` (dock).
	 */
	as?: 'command-item' | 'menuitem';
	className?: string;
}

const SIZES = {
	md: { row: 'gap-3 px-3 py-2 text-sm', icon: 'h-4 w-4' },
	sm: { row: 'gap-2 px-2 py-1.5 text-xs', icon: 'h-3.5 w-3.5' },
} as const;

/**
 * The single interactive row inside any keyboard-first command list — the ⌘K
 * palette, the pane new-tab (`+`) menu, and the dock `+` dropdown. Consolidates
 * the three former hand-rolled rows (`PaletteItem` / `MenuItem` / `DockMenuItem`)
 * into one implementation: shared geometry, the `ShortcutChip`, a `focus-visible`
 * ring the originals lacked, and kbd/detail support the dock row never had.
 */
export function CommandRow({
	onSelect,
	Icon,
	label,
	shortcut,
	detail,
	disabled,
	size = 'md',
	as = 'command-item',
	className,
}: CommandRowProps) {
	const sz = SIZES[size];
	const inner = (
		<>
			<Icon className={cn(sz.icon, 'shrink-0 text-muted-foreground')} aria-hidden="true" />
			<span className="flex-1 truncate">{label}</span>
			{detail && (
				<span className="shrink-0 truncate text-[10px] text-muted-foreground">{detail}</span>
			)}
			{shortcut && <ShortcutChip aria-hidden="true">{shortcut}</ShortcutChip>}
		</>
	);

	// Restore a focus-visible ring the global `outline:none` reset strips —
	// closes the WCAG 2.4.7 gap all three originals left open.
	const focusRing =
		'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset';

	if (as === 'menuitem') {
		return (
			<button
				type="button"
				role="menuitem"
				onClick={onSelect}
				disabled={disabled}
				className={cn(
					'flex w-full items-center text-left transition-colors motion-reduce:transition-none',
					sz.row,
					focusRing,
					'hover:bg-accent hover:text-accent-foreground',
					'disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent',
					className
				)}
			>
				{inner}
			</button>
		);
	}

	return (
		<Command.Item
			onSelect={onSelect}
			disabled={disabled}
			className={cn(
				'flex cursor-pointer items-center rounded-md transition-colors motion-reduce:transition-none',
				sz.row,
				focusRing,
				'aria-selected:bg-accent aria-selected:text-accent-foreground',
				'data-[disabled=true]:cursor-not-allowed data-[disabled=true]:opacity-50',
				className
			)}
		>
			{inner}
		</Command.Item>
	);
}
