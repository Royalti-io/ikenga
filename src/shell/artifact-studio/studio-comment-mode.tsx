// Comment-mode overlay for the Studio's render panel.
//
// When the user toggles comment mode on (Studio chrome), this component
// mounts above the rendered artifact iframe. It reaches into the iframe's
// same-origin document, attaches pointer listeners, draws a highlight
// around the hovered element, and — on click — captures a `PickResult`
// (selector + screenshot + position) via the shared `capture` helper so
// the unified `PinComposer` modal handles the rest.
//
// Same-origin access is safe here: the artifact iframe is served by the
// shell's own viewer-server, so `iframe.contentDocument` is reachable
// from the parent. The viewer-server also injects the `@ikenga/artifact`
// bridge into served HTML, which means the iframe's <html> already has
// the right CSP / sandbox flags for this access pattern.

import { useEffect, useRef, useState } from 'react';
import { capture, type PickResult } from '@/shell/artifact-studio/pin-composer';

interface StudioCommentModeProps {
	paneId: string;
	onPick: (result: PickResult) => void;
}

interface Rect {
	top: number;
	left: number;
	width: number;
	height: number;
}

export function StudioCommentMode({ paneId, onPick }: StudioCommentModeProps) {
	const overlayRef = useRef<HTMLDivElement | null>(null);
	const [highlight, setHighlight] = useState<Rect | null>(null);
	const [busy, setBusy] = useState(false);

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
			teardown = attachListeners(iframe, overlayRef.current, setHighlight, onPick, setBusy);
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
	}, [paneId, onPick]);

	return (
		<div ref={overlayRef} className="pointer-events-none absolute inset-0 z-10">
			{highlight && (
				<div
					className={
						busy
							? 'absolute rounded-sm border-2 border-amber-300 bg-amber-300/20 transition-all duration-75'
							: 'absolute rounded-sm border-2 border-amber-500 bg-amber-500/10 transition-all duration-75'
					}
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
	onPick: (result: PickResult) => void,
	setBusy: (b: boolean) => void
): () => void {
	const doc = iframe.contentDocument;
	if (!doc) return () => undefined;

	const onMove = (e: MouseEvent) => {
		// Cross-frame `instanceof Element` is unreliable when `e.target` lives
		// in the iframe's document (different Element constructor). Duck-type
		// against `nodeType === 1` so iframe elements pass the check.
		const t = e.target as { nodeType?: number; getBoundingClientRect?: () => DOMRect } | null;
		if (!t || t.nodeType !== 1 || typeof t.getBoundingClientRect !== 'function') {
			setHighlight(null);
			return;
		}
		const rect = t.getBoundingClientRect();
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
	let cancelled = false;
	const onClick = (e: MouseEvent) => {
		if (!(e.target instanceof Element)) {
			// Cross-frame `instanceof Element` (iframe.contentWindow.Element !==
			// window.Element) can fail even for real elements. Fall back to a
			// duck-typed nodeType check before bailing.
			const t = e.target as { nodeType?: number } | null;
			if (!t || t.nodeType !== 1) return;
		}
		const el = e.target as Element;
		// Skip bare <html>/<body> — same guard as the right-click picker.
		if (el === doc.documentElement || el === doc.body) return;
		e.preventDefault();
		e.stopPropagation();
		setBusy(true);
		capture(iframe, el)
			.then((result) => {
				if (cancelled) return;
				onPick(result);
			})
			.catch((err) => {
				console.error('[comment-mode] capture failed', err);
			})
			.finally(() => {
				if (!cancelled) setBusy(false);
			});
	};

	const onLeave = () => setHighlight(null);

	doc.addEventListener('mousemove', onMove, true);
	doc.addEventListener('click', onClick, true);
	doc.addEventListener('mouseleave', onLeave, true);

	return () => {
		cancelled = true;
		doc.removeEventListener('mousemove', onMove, true);
		doc.removeEventListener('click', onClick, true);
		doc.removeEventListener('mouseleave', onLeave, true);
		setHighlight(null);
	};
}
