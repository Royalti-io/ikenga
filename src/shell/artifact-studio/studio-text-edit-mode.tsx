// Text-edit mode overlay for the Studio's render panel.
//
// Twin of `studio-comment-mode.tsx` but instead of pinning the clicked
// element as a terminal chip, it flips the element to `contentEditable`,
// focuses it, and commits the new inner HTML back to the artifact file
// on blur (or `Cmd+Enter`). `Escape` aborts and restores the original
// markup.
//
// Same-origin access is safe: viewer-server serves the iframe from the
// shell's own origin, and the iframe carries `sandbox="allow-scripts
// allow-same-origin"`, so `iframe.contentDocument` is reachable from
// the parent.
//
// Write-back strategy: surgical find-and-replace via DOMParser on the
// current source string. The selector that `deriveSelector` produces
// for the clicked element is re-run against a parsed copy of the
// on-disk HTML; the matched element's `innerHTML` is swapped for the
// edited value; the whole document is serialized back. Comments and
// surrounding markup outside the target element are preserved by the
// DOM round-trip; minor whitespace / attribute-ordering drift inside
// the target is the documented tradeoff.

import { useEffect, useRef, useState } from 'react';
import * as M from '@/lib/artifact/bridge-messages';
import { wrapHostMessage } from '@/lib/artifact/bridge-messages';

interface Rect {
	top: number;
	left: number;
	width: number;
	height: number;
}

interface StudioTextEditModeProps {
	paneId: string;
	/** Current on-disk source. Used to compute the rewritten source via
	 *  DOMParser; the loupe owns disk writes. */
	source: string;
	/** Called with the rewritten source when the user commits an edit.
	 *  The loupe persists it (auto-save, like engine edits). */
	onCommit: (nextSource: string) => void;
}

export function StudioTextEditMode({ paneId, source, onCommit }: StudioTextEditModeProps) {
	const overlayRef = useRef<HTMLDivElement | null>(null);
	const [highlight, setHighlight] = useState<Rect | null>(null);
	// Keep `source` in a ref so the commit handler always sees the latest
	// without re-binding listeners on every keystroke.
	const sourceRef = useRef(source);
	sourceRef.current = source;
	const onCommitRef = useRef(onCommit);
	onCommitRef.current = onCommit;

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
			postToChild({ kind: 'start-text-edit' });
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
			} else if (m.kind === 'text-edit-pick') {
				if (!iframe || !overlayRef.current) return;
				const iframeRect = iframe.getBoundingClientRect();
				const overlayRect = overlayRef.current.getBoundingClientRect();
				setHighlight({
					top: m.rect.top + (iframeRect.top - overlayRect.top),
					left: m.rect.left + (iframeRect.left - overlayRect.left),
					width: m.rect.width,
					height: m.rect.height,
				});
			} else if (m.kind === 'text-edit-commit') {
				setHighlight(null);
				if (m.innerHtml === m.originalHtml) return;
				const rewritten = rewriteElementHtml(sourceRef.current, m.selector, m.innerHtml);
				if (rewritten === null) {
					console.warn('[text-edit] selector did not resolve in source', m.selector);
					return;
				}
				onCommitRef.current(rewritten);
			} else if (m.kind === 'text-edit-cancel') {
				setHighlight(null);
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
			postToChild({ kind: 'stop-text-edit' });
		};
	}, [paneId]);

	return (
		<div ref={overlayRef} className="pointer-events-none absolute inset-0 z-10">
			{highlight && (
				<div
					className="absolute rounded-sm border-2 border-sky-500 bg-sky-500/10 transition-all duration-75"
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

/** Surgical write-back via DOMParser. Returns the rewritten source string,
 *  or null if the selector failed to resolve in the parsed document. */
export function rewriteElementHtml(
	source: string,
	selector: string,
	nextInnerHtml: string
): string | null {
	const parser = new DOMParser();
	const doc = parser.parseFromString(source, 'text/html');
	const target = doc.querySelector(selector);
	if (!target) return null;
	target.innerHTML = nextInnerHtml;
	// Preserve a DOCTYPE prelude — DOMParser drops it from outerHTML.
	// We round-trip the first `<!doctype html>` (case-insensitive) from
	// the source so the rewritten file stays valid HTML5. Falls back to
	// the canonical `<!DOCTYPE html>` when missing.
	const doctypeMatch = source.match(/<!doctype[^>]*>/i);
	const doctype = doctypeMatch ? doctypeMatch[0] : '<!DOCTYPE html>';
	return `${doctype}\n${doc.documentElement.outerHTML}\n`;
}
