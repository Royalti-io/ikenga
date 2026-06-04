import { useEffect, useLayoutEffect, useRef } from 'react';

// Shared focus-management hooks for the shell's bespoke (non-Radix) overlays.
// The shadcn Dialog/Popover/Sheet primitives already trap + return focus; these
// cover the hand-rolled portal dialogs (command palette, studio pin/folder/
// override popovers, ngwa write-drawer, pkg loupe) that don't.
//
// Spec: plans/shell-design-system P4 screen forward-reqs (WCAG 2.4.3 Focus
// Order, 2.1.2 No Keyboard Trap — the trap is escapable because callers own Esc).

const FOCUSABLE = [
	'a[href]',
	'button:not([disabled])',
	'input:not([disabled])',
	'select:not([disabled])',
	'textarea:not([disabled])',
	'[tabindex]:not([tabindex="-1"])',
].join(',');

function visibleFocusables(container: HTMLElement): HTMLElement[] {
	return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
		(el) => el.offsetParent !== null || el === document.activeElement
	);
}

export interface FocusTrapOptions {
	/** Trap is live only while enabled (e.g. the overlay's `open` flag). */
	enabled: boolean;
	/** Element to restore focus to on teardown. Defaults to whatever was focused
	 *  when the trap engaged (usually the trigger). */
	returnFocusRef?: React.RefObject<HTMLElement | null>;
	/** CSS selector (within the container) for the element to focus first. */
	initialFocusSelector?: string;
}

/** Trap keyboard focus within `containerRef` while `enabled`, cycling Tab /
 *  Shift+Tab at the edges, and return focus to the trigger on teardown. Esc is
 *  the caller's responsibility (so the trap is escapable — WCAG 2.1.2). */
export function useFocusTrap(
	containerRef: React.RefObject<HTMLElement | null>,
	{ enabled, returnFocusRef, initialFocusSelector }: FocusTrapOptions
): void {
	useEffect(() => {
		if (!enabled) return;
		const container = containerRef.current;
		if (!container) return;

		const toRestore = (returnFocusRef?.current ??
			(document.activeElement as HTMLElement | null)) as HTMLElement | null;

		// Initial focus: explicit selector → first focusable → the container itself.
		const initial =
			(initialFocusSelector && container.querySelector<HTMLElement>(initialFocusSelector)) ||
			visibleFocusables(container)[0] ||
			container;
		if (initial === container && !container.hasAttribute('tabindex')) {
			container.setAttribute('tabindex', '-1');
		}
		requestAnimationFrame(() => initial?.focus?.());

		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key !== 'Tab') return;
			const items = visibleFocusables(container);
			const active = document.activeElement as HTMLElement | null;
			if (items.length === 0) {
				e.preventDefault();
				container.focus?.();
				return;
			}
			const first = items[0];
			const last = items[items.length - 1];
			if (e.shiftKey) {
				if (active === first || !container.contains(active)) {
					e.preventDefault();
					last.focus();
				}
			} else if (active === last || !container.contains(active)) {
				e.preventDefault();
				first.focus();
			}
		};

		document.addEventListener('keydown', onKeyDown, true);
		return () => {
			document.removeEventListener('keydown', onKeyDown, true);
			toRestore?.focus?.();
		};
	}, [enabled, containerRef, returnFocusRef, initialFocusSelector]);
}

/** Restore focus to the pre-open element when an overlay closes. Lighter than
 *  useFocusTrap — for overlays that own their internal focus (e.g. cmdk) but
 *  lose the return-to-trigger on close. Tracks the focused element while closed
 *  (that's the trigger) and refocuses it on the open→closed transition. */
export function useFocusReturn(open: boolean): void {
	const triggerRef = useRef<HTMLElement | null>(null);
	const prevOpen = useRef(false);
	useLayoutEffect(() => {
		const closing = prevOpen.current && !open;
		// Track the trigger only while stably closed — never on the closing
		// frame (activeElement is mid-teardown then).
		if (!open && !closing) {
			const ae = document.activeElement as HTMLElement | null;
			if (ae && ae !== document.body) triggerRef.current = ae;
		}
		if (closing && triggerRef.current) {
			const el = triggerRef.current;
			requestAnimationFrame(() => el.focus?.());
		}
		prevOpen.current = open;
	});
}
