// Text-edit mode overlay for the Studio's render panel.
//
// Twin of `studio-comment-mode.tsx` but instead of pinning the clicked
// element as a chat chip, it flips the element to `contentEditable`,
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
import { deriveSelector } from '@/lib/artifact/selector';

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

interface EditingState {
	el: HTMLElement;
	selector: string;
	originalHtml: string;
}

export function StudioTextEditMode({ paneId, source, onCommit }: StudioTextEditModeProps) {
	const overlayRef = useRef<HTMLDivElement | null>(null);
	const [highlight, setHighlight] = useState<Rect | null>(null);
	const editingRef = useRef<EditingState | null>(null);
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
		let attached = false;
		let teardown: (() => void) | null = null;

		const tryAttach = () => {
			if (cancelled || attached) return;
			const iframe = root.querySelector('iframe');
			if (!iframe?.contentDocument) return;
			attached = true;
			teardown = attachListeners(
				iframe,
				overlayRef.current,
				setHighlight,
				editingRef,
				sourceRef,
				onCommitRef
			);
		};

		tryAttach();
		const interval = window.setInterval(tryAttach, 100);
		const stop = window.setTimeout(() => window.clearInterval(interval), 2000);

		return () => {
			cancelled = true;
			window.clearInterval(interval);
			window.clearTimeout(stop);
			// Revert any in-flight edit so mode-toggling can't strand a
			// document with contentEditable still active.
			const cur = editingRef.current;
			if (cur) {
				cur.el.contentEditable = 'inherit';
				cur.el.innerHTML = cur.originalHtml;
				editingRef.current = null;
			}
			if (teardown) teardown();
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
	// the canonical `<!doctype html>` when missing.
	const doctypeMatch = source.match(/<!doctype[^>]*>/i);
	const doctype = doctypeMatch ? doctypeMatch[0] : '<!DOCTYPE html>';
	return `${doctype}\n${doc.documentElement.outerHTML}\n`;
}

function attachListeners(
	iframe: HTMLIFrameElement,
	overlay: HTMLElement | null,
	setHighlight: (r: Rect | null) => void,
	editingRef: { current: EditingState | null },
	sourceRef: { current: string },
	onCommitRef: { current: (nextSource: string) => void }
): () => void {
	const doc = iframe.contentDocument;
	if (!doc) return () => undefined;

	const commit = () => {
		const cur = editingRef.current;
		if (!cur) return;
		const newHtml = cur.el.innerHTML;
		cur.el.contentEditable = 'inherit';
		editingRef.current = null;
		setHighlight(null);
		if (newHtml === cur.originalHtml) return;
		const rewritten = rewriteElementHtml(sourceRef.current, cur.selector, newHtml);
		if (rewritten === null) {
			console.warn('[text-edit] selector did not resolve in source', cur.selector);
			cur.el.innerHTML = cur.originalHtml;
			return;
		}
		onCommitRef.current(rewritten);
	};

	const cancel = () => {
		const cur = editingRef.current;
		if (!cur) return;
		cur.el.innerHTML = cur.originalHtml;
		cur.el.contentEditable = 'inherit';
		editingRef.current = null;
		setHighlight(null);
	};

	const onMove = (e: MouseEvent) => {
		if (editingRef.current) {
			setHighlight(null);
			return;
		}
		const t = e.target as { nodeType?: number; getBoundingClientRect?: () => DOMRect } | null;
		if (!t || t.nodeType !== 1 || typeof t.getBoundingClientRect !== 'function') {
			setHighlight(null);
			return;
		}
		const rect = t.getBoundingClientRect();
		const iframeRect = iframe.getBoundingClientRect();
		const overlayRect = overlay?.getBoundingClientRect();
		setHighlight({
			top: rect.top + (iframeRect.top - (overlayRect?.top ?? iframeRect.top)),
			left: rect.left + (iframeRect.left - (overlayRect?.left ?? iframeRect.left)),
			width: rect.width,
			height: rect.height,
		});
	};

	const onClick = (e: MouseEvent) => {
		// If something is already editing, this click should commit it
		// (the blur listener will fire too — commit is idempotent via the
		// nulled-out editingRef).
		if (editingRef.current) {
			commit();
			return;
		}
		const t = e.target as { nodeType?: number; tagName?: string } | null;
		if (!t || t.nodeType !== 1) return;
		const el = e.target as HTMLElement;
		// Skip elements that have no text content — making an empty `<div>`
		// editable just confuses the user.
		const textContent = (el.textContent ?? '').trim();
		if (!textContent) return;
		e.preventDefault();
		e.stopPropagation();
		const selector = deriveSelector(el);
		if (!selector) return;
		const originalHtml = el.innerHTML;
		el.contentEditable = 'true';
		editingRef.current = { el, selector, originalHtml };
		el.focus();
		// Place the caret at the end of the element's text for the user
		// to continue typing without first manually positioning.
		const range = doc.createRange();
		range.selectNodeContents(el);
		range.collapse(false);
		const sel = doc.defaultView?.getSelection();
		if (sel) {
			sel.removeAllRanges();
			sel.addRange(range);
		}
	};

	const onBlur = (e: FocusEvent) => {
		const cur = editingRef.current;
		if (!cur) return;
		if (e.target !== cur.el) return;
		commit();
	};

	const onKey = (e: KeyboardEvent) => {
		const cur = editingRef.current;
		if (!cur) return;
		if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			cancel();
			return;
		}
		// Cmd/Ctrl+Enter commits (matches the pin-composer + IDE conventions);
		// plain Enter inserts a newline so multi-line content stays editable.
		if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			e.stopPropagation();
			commit();
		}
	};

	doc.addEventListener('mousemove', onMove, true);
	doc.addEventListener('click', onClick, true);
	doc.addEventListener('blur', onBlur, true);
	doc.addEventListener('keydown', onKey, true);

	return () => {
		doc.removeEventListener('mousemove', onMove, true);
		doc.removeEventListener('click', onClick, true);
		doc.removeEventListener('blur', onBlur, true);
		doc.removeEventListener('keydown', onKey, true);
		setHighlight(null);
	};
}
