// Editor↔preview scroll & cursor sync for the markdown editor.
//
// The preview stamps `data-source-line` on every block (see `Markdown`'s
// `sourceLines` prop). We map the editor's top visible line — and the caret
// line — to the nearest stamped block and align the preview to it, with linear
// interpolation between anchors so motion stays smooth across blocks of uneven
// rendered height. A short timestamp lock prevents the two panes' scroll
// handlers from ping-ponging.
//
// We avoid importing `@codemirror/*` (not a shell dependency) — everything is
// driven through plain DOM listeners + methods on the live `EditorView`, whose
// type we borrow from the editor handle.

import { useCallback, useEffect, useRef } from 'react';
import type { CodeEditorHandle } from '@ikenga/ui-lib';

type View = NonNullable<ReturnType<CodeEditorHandle['view']>>;

interface ScrollSyncOptions {
	getView: () => View | null;
	previewRef: React.RefObject<HTMLElement | null>;
	enabled: boolean;
}

export function useScrollSync({ getView, previewRef, enabled }: ScrollSyncOptions): {
	onPreviewScroll: () => void;
} {
	// After a programmatic scroll on one side, ignore the other side's scroll
	// events for a beat so they don't drive each other in a loop. Stable
	// identity (useCallback over a ref) so the sync callbacks below stay stable.
	const lockUntil = useRef(0);
	const locked = useCallback(() => performance.now() < lockUntil.current, []);
	const lock = useCallback(() => {
		lockUntil.current = performance.now() + 120;
	}, []);

	// Map a 1-based source line to a scrollTop in the preview, interpolating
	// between the bracketing stamped anchors.
	const previewTopForLine = useCallback((preview: HTMLElement, line: number): number | null => {
		const anchors = Array.from(preview.querySelectorAll<HTMLElement>('[data-source-line]'));
		if (anchors.length === 0) return null;
		const lineOf = (el: HTMLElement) => Number(el.getAttribute('data-source-line'));
		const topOf = (el: HTMLElement) =>
			el.getBoundingClientRect().top - preview.getBoundingClientRect().top + preview.scrollTop;

		let prev: HTMLElement | null = null;
		let next: HTMLElement | null = null;
		for (const el of anchors) {
			if (lineOf(el) <= line) prev = el;
			else {
				next = el;
				break;
			}
		}
		const base = prev ?? anchors[0];
		if (!prev || !next) return topOf(base);
		const bl = lineOf(base);
		const nl = lineOf(next);
		const f = nl === bl ? 0 : (line - bl) / (nl - bl);
		return topOf(base) + f * (topOf(next) - topOf(base));
	}, []);

	const syncEditorToPreview = useCallback(() => {
		const view = getView();
		const preview = previewRef.current;
		if (!view || !preview || locked()) return;
		const block = view.lineBlockAtHeight(view.scrollDOM.scrollTop);
		const line = view.state.doc.lineAt(block.from).number;
		const target = previewTopForLine(preview, line);
		if (target == null) return;
		lock();
		preview.scrollTop = target;
	}, [getView, previewRef, previewTopForLine, lock, locked]);

	const syncCursorToPreview = useCallback(() => {
		const view = getView();
		const preview = previewRef.current;
		if (!view || !preview || !view.hasFocus || locked()) return;
		const head = view.state.selection.main.head;
		const line = view.state.doc.lineAt(head).number;
		const target = previewTopForLine(preview, line);
		if (target == null) return;
		// Leave it alone if the caret's block is already comfortably on screen —
		// avoids yanking the preview around while typing mid-viewport.
		const band = preview.clientHeight;
		const rel = target - preview.scrollTop;
		if (rel >= band * 0.1 && rel <= band * 0.8) return;
		lock();
		preview.scrollTop = Math.max(0, target - band * 0.3);
	}, [getView, previewRef, previewTopForLine, lock, locked]);

	const onPreviewScroll = useCallback(() => {
		const view = getView();
		const preview = previewRef.current;
		if (!view || !preview || locked()) return;
		const anchors = Array.from(preview.querySelectorAll<HTMLElement>('[data-source-line]'));
		if (anchors.length === 0) return;
		const pTop = preview.getBoundingClientRect().top;
		// Topmost block at or above the preview's top edge.
		let chosen = anchors[0];
		for (const el of anchors) {
			if (el.getBoundingClientRect().top - pTop <= 1) chosen = el;
			else break;
		}
		const line = Number(chosen.getAttribute('data-source-line'));
		const clamped = Math.min(Math.max(line, 1), view.state.doc.lines);
		const block = view.lineBlockAt(view.state.doc.line(clamped).from);
		lock();
		view.scrollDOM.scrollTop = block.top;
	}, [getView, previewRef, lock, locked]);

	useEffect(() => {
		if (!enabled) return;
		let raf = 0;
		let scrollDOM: HTMLElement | null = null;
		const attach = () => {
			const view = getView();
			if (!view) {
				raf = requestAnimationFrame(attach);
				return;
			}
			scrollDOM = view.scrollDOM;
			scrollDOM.addEventListener('scroll', syncEditorToPreview, { passive: true });
			document.addEventListener('selectionchange', syncCursorToPreview);
		};
		attach();
		return () => {
			cancelAnimationFrame(raf);
			scrollDOM?.removeEventListener('scroll', syncEditorToPreview);
			document.removeEventListener('selectionchange', syncCursorToPreview);
		};
	}, [enabled, getView, syncEditorToPreview, syncCursorToPreview]);

	return { onPreviewScroll };
}
