import * as React from 'react';

import { cn } from '@/components/ui/utils';

// Shared compact icon-only action button — the 24×24 toolbar/chrome button the
// pane toolbar, address bar, studio loupe chrome, and dock controls all render
// through. Consolidates the duplicated ToolButton / NavButton / ChromeButton +
// the inline dock buttons into one, adding the missing focus-visible ring.
// Forwards a ref (the dock add-button anchors a popover) and spreads the rest
// (data-*, aria-haspopup/expanded, …).
//
// Spec: plans/shell-design-system/parts/components/icon-toolbar-button.md
//       + designs/icon-toolbar-button.html (the locked Dusk Wood mockup).

export interface IconButtonProps extends React.ComponentProps<'button'> {
	/** Toggle / selected state — sets `aria-pressed` + the active background. */
	active?: boolean;
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
	{ active, className, type = 'button', ...props },
	ref
) {
	return (
		<button
			ref={ref}
			type={type}
			aria-pressed={active === undefined ? undefined : active}
			className={cn(
				'flex h-6 w-6 shrink-0 items-center justify-center rounded transition-colors motion-reduce:transition-none',
				'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
				'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent',
				active
					? 'bg-accent text-accent-foreground'
					: 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
				className
			)}
			{...props}
		/>
	);
});
