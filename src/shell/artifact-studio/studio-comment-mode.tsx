// Comment-mode overlay for the Studio's render panel.
//
// When the user toggles comment mode on (Studio chrome), this component
// mounts above the rendered artifact iframe. It reaches into the iframe's
// same-origin document, attaches pointer listeners, draws a highlight
// around the hovered element, and — on click — derives a stable selector
// via `deriveSelector` and reports it up so the engine chat can pin it
// as a chip.
//
// Same-origin access is safe here: the artifact iframe is served by the
// shell's own viewer-server, so `iframe.contentDocument` is reachable
// from the parent. The viewer-server also injects the `@ikenga/artifact`
// bridge into served HTML, which means the iframe's <html> already has
// the right CSP / sandbox flags for this access pattern.

import { useEffect, useRef, useState } from 'react';
import { deriveSelector } from '@/lib/artifact/selector';

interface StudioCommentModeProps {
	paneId: string;
	onSelect: (selector: string) => void;
}

interface Rect {
	top: number;
	left: number;
	width: number;
	height: number;
}

export function StudioCommentMode({ paneId, onSelect }: StudioCommentModeProps) {
	const overlayRef = useRef<HTMLDivElement | null>(null);
	const [highlight, setHighlight] = useState<Rect | null>(null);

	useEffect(() => {
		// Find the artifact iframe by walking up to the Studio pane root and
		// querying for the first iframe inside. The Studio root sets
		// `data-pane-id` for exactly this kind of scoped lookup.
		const root = document.querySelector<HTMLElement>(`[data-pane-id="${paneId}"]`);
		if (!root) return;
		// The iframe may not be mounted yet (viewer-server is async). Poll
		// briefly; comment-mode is user-triggered so a 200ms window is plenty.
		let cancelled = false;
		let attached = false;
		let teardown: (() => void) | null = null;

		const tryAttach = () => {
			if (cancelled || attached) return;
			const iframe = root.querySelector('iframe');
			if (!iframe?.contentDocument) return;
			attached = true;
			teardown = attachListeners(iframe, overlayRef.current, setHighlight, onSelect);
		};

		tryAttach();
		const interval = window.setInterval(tryAttach, 100);
		const stop = window.setTimeout(() => window.clearInterval(interval), 2000);

		return () => {
			cancelled = true;
			window.clearInterval(interval);
			window.clearTimeout(stop);
			if (teardown) teardown();
		};
	}, [paneId, onSelect]);

	return (
		<div ref={overlayRef} className="pointer-events-none absolute inset-0 z-10">
			{highlight && (
				<div
					className="absolute rounded-sm border-2 border-amber-500 bg-amber-500/10 transition-all duration-75"
					style={{
						top: highlight.top,
						left: highlight.left,
						width: highlight.width,
						height: highlight.height,
					}}
				/>
			)}
		</div>
	);
}

/** Attach mousemove + click listeners to the iframe document. Returns a
 *  teardown function. `setHighlight` receives bounding rects in
 *  overlay-relative coords so the highlight box sits over the iframe. */
function attachListeners(
	iframe: HTMLIFrameElement,
	overlay: HTMLElement | null,
	setHighlight: (r: Rect | null) => void,
	onSelect: (selector: string) => void,
): () => void {
	const doc = iframe.contentDocument;
	if (!doc) return () => undefined;

	const onMove = (e: MouseEvent) => {
		if (!(e.target instanceof Element)) {
			setHighlight(null);
			return;
		}
		const rect = e.target.getBoundingClientRect();
		const iframeRect = iframe.getBoundingClientRect();
		const overlayRect = overlay?.getBoundingClientRect();
		// The overlay sits over the iframe. Translate the iframe-doc rect into
		// overlay-relative coords by adding the iframe's offset from the
		// overlay's top-left.
		setHighlight({
			top: rect.top + (iframeRect.top - (overlayRect?.top ?? iframeRect.top)),
			left: rect.left + (iframeRect.left - (overlayRect?.left ?? iframeRect.left)),
			width: rect.width,
			height: rect.height,
		});
	};

	const onClick = (e: MouseEvent) => {
		if (!(e.target instanceof Element)) return;
		e.preventDefault();
		e.stopPropagation();
		const selector = deriveSelector(e.target);
		if (selector) onSelect(selector);
	};

	const onLeave = () => setHighlight(null);

	doc.addEventListener('mousemove', onMove, true);
	doc.addEventListener('click', onClick, true);
	doc.addEventListener('mouseleave', onLeave, true);
	// Block scroll-into-view / form submits while comment-mode is on. The
	// listeners are attached in capture phase so they fire before the
	// artifact's own handlers.

	return () => {
		doc.removeEventListener('mousemove', onMove, true);
		doc.removeEventListener('click', onClick, true);
		doc.removeEventListener('mouseleave', onLeave, true);
		setHighlight(null);
	};
}
