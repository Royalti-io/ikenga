// Right-click element picker for HTML-artifact iframes.
//
// Lifecycle: the host (HtmlFrame) calls `attachElementPicker(iframe, onPick)`
// once the same-origin iframe has loaded. We add a `contextmenu` listener
// on `iframe.contentDocument` that captures the clicked element, computes
// a CSS selector, normalises its bounding rect, and asks
// `modern-screenshot` to render *just that element* to a PNG. The caller
// gets a `PickResult` and is responsible for opening the composer modal.
//
// Returns a teardown thunk. Safe to call multiple times — repeated
// `attach` on the same iframe replaces the listener.

import { captureToPng } from '@/lib/screenshot';
import { cssSelectorFor } from './selector';

export interface PickResult {
	/** CSS selector that round-trips to the picked element via querySelector. */
	selector: string;
	/** Position fraction inside the iframe viewport (0..1). 0,0 = top-left. */
	positionX: number;
	positionY: number;
	/** Element screenshot, base64-encoded PNG. */
	screenshotBase64: string;
	screenshotWidth: number;
	screenshotHeight: number;
	/** A 1-2 word description for the picker's "you clicked: foo" preview.
	 *  Best-effort — uses tagName + truncated text content. */
	elementLabel: string;
}

const ATTACHED = new WeakMap<HTMLIFrameElement, () => void>();

export function attachElementPicker(
	iframe: HTMLIFrameElement,
	onPick: (result: PickResult) => void
): () => void {
	// Tear down any prior listener — replacing the callback is the common
	// case (composer state changes, parent re-renders the picker).
	ATTACHED.get(iframe)?.();

	const doc = iframe.contentDocument;
	if (!doc) {
		// Iframe not loaded yet, or cross-origin (shouldn't happen — viewer
		// server is same-origin). Caller will retry on the next ready tick.
		return () => undefined;
	}

	const handler = (ev: MouseEvent) => {
		// Cross-frame `instanceof Element` (iframe.contentWindow.Element !==
		// window.Element) returns false for elements that live inside the
		// iframe's document, so duck-type on `nodeType === 1` instead — same
		// fix as `studio-comment-mode.tsx`.
		const t = ev.target as { nodeType?: number } | null;
		if (!t || t.nodeType !== 1) return;
		const el = ev.target as Element;
		// Don't intercept on the bare <html>/<body> — that's almost never
		// what the user means by "pin this element".
		if (el === doc.documentElement || el === doc.body) return;
		ev.preventDefault();
		ev.stopPropagation();
		void capture(iframe, el)
			.then(onPick)
			.catch((err) => {
				// Surface the failure in the console; the host modal stays closed.
				// Cropping an element should be reliable on a same-origin doc;
				// the most likely failure is an off-screen / 0-area node.
				console.error('[pin-picker] capture failed', err);
			});
	};
	doc.addEventListener('contextmenu', handler, true);

	const teardown = () => {
		doc.removeEventListener('contextmenu', handler, true);
		ATTACHED.delete(iframe);
	};
	ATTACHED.set(iframe, teardown);
	return teardown;
}

/** Capture a `PickResult` for the given element in an iframe. Shared by the
 *  right-click picker and the Studio's comment-mode click handler so both
 *  pin-creation surfaces produce byte-identical selectors + screenshots. */
export async function capture(iframe: HTMLIFrameElement, el: Element): Promise<PickResult> {
	const doc = iframe.contentDocument!;
	const root = doc.documentElement;
	const rect = el.getBoundingClientRect();
	// Center of the element as a fraction of the iframe's scroll viewport.
	// Using documentElement.scroll{Width,Height} (not innerWidth) so a
	// scrolled artifact still anchors correctly.
	const w = Math.max(1, root.scrollWidth || iframe.clientWidth);
	const h = Math.max(1, root.scrollHeight || iframe.clientHeight);
	const positionX = clamp01((rect.left + rect.width / 2 + (doc.defaultView?.scrollX ?? 0)) / w);
	const positionY = clamp01((rect.top + rect.height / 2 + (doc.defaultView?.scrollY ?? 0)) / h);

	const shot = await captureToPng(el as HTMLElement);

	return {
		selector: cssSelectorFor(el),
		positionX,
		positionY,
		screenshotBase64: shot.base64,
		screenshotWidth: shot.width,
		screenshotHeight: shot.height,
		elementLabel: labelFor(el),
	};
}

function labelFor(el: Element): string {
	const tag = el.tagName.toLowerCase();
	const text = (el.textContent ?? '').trim().slice(0, 40);
	if (!text) return tag;
	return `${tag} — ${text}${(el.textContent ?? '').length > 40 ? '…' : ''}`;
}

function clamp01(v: number): number {
	if (!Number.isFinite(v)) return 0;
	if (v < 0) return 0;
	if (v > 1) return 1;
	return v;
}
