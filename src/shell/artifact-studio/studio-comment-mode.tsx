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
import { type PickResult } from '@/shell/artifact-studio/pin-composer';
import * as M from '@/lib/artifact/bridge-messages';
import { wrapHostMessage } from '@/lib/artifact/bridge-messages';

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
		const root = document.querySelector<HTMLElement>(`[data-pane-id="${paneId}"]`);
		if (!root) return;

		let cancelled = false;
		let iframe: HTMLIFrameElement | null = null;

		const postToChild = (msg: M.HostToChildMessage) => {
			const cw = iframe?.contentWindow;
			if (!cw) return;
			cw.postMessage(wrapHostMessage(msg), '*');
		};

		const tryAttach = () => {
			if (cancelled || iframe) return;
			const el = root.querySelector('iframe');
			if (!el) return;
			iframe = el;
			postToChild({ kind: 'start-comment' });
		};

		const onMessage = (e: MessageEvent) => {
			if (!M.isIkengaHostMessage(e.data)) return;
			if (e.source !== iframe?.contentWindow) return;
			const m = (e.data as M.ChildMessageWrapper).data;

			if (m.kind === 'hover') {
				if (!m.rect) {
					setHighlight(null);
					return;
				}
				if (!iframe || !overlayRef.current) return;
				const iframeRect = iframe.getBoundingClientRect();
				const overlayRect = overlayRef.current.getBoundingClientRect();
				setHighlight({
					top: m.rect.top + (iframeRect.top - overlayRect.top),
					left: m.rect.left + (iframeRect.left - overlayRect.left),
					width: m.rect.width,
					height: m.rect.height,
				});
			} else if (m.kind === 'comment-pick') {
				setBusy(true);
				const p = m.payload;
				onPick({
					selector: p.selector,
					positionX: p.positionX,
					positionY: p.positionY,
					screenshotBase64: p.screenshotBase64,
					screenshotWidth: p.screenshotWidth,
					screenshotHeight: p.screenshotHeight,
					elementLabel: p.elementLabel,
				});
				setBusy(false);
			}
		};

		tryAttach();
		const interval = window.setInterval(tryAttach, 100);
		const stop = window.setTimeout(() => window.clearInterval(interval), 2000);
		window.addEventListener('message', onMessage);

		return () => {
			cancelled = true;
			window.clearInterval(interval);
			window.clearTimeout(stop);
			window.removeEventListener('message', onMessage);
			postToChild({ kind: 'stop-comment' });
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
