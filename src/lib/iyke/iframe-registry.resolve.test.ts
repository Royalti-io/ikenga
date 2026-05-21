// Pane-id prefix resolution (#5): `iyke state` prints an 8-char-truncated pane
// id, but the registry is keyed by the full id — so dom/click `--pane <short>`
// used to miss and fall back to host targeting. resolveIframePaneId closes
// that gap with exact-then-unique-prefix matching.

import { afterEach, describe, expect, it } from 'vitest';
import { registerIykeIframe, resolveIframePaneId, getIframe } from './iframe-registry';

function fakeIframe(): HTMLIFrameElement {
	const el = document.createElement('iframe');
	document.body.appendChild(el);
	return el;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length) cleanups.pop()!();
	document.body.innerHTML = '';
});

describe('resolveIframePaneId', () => {
	it('resolves a truncated 8-char prefix to the full pane id', () => {
		const full = 'ed002673-072d-48ea-8772-b2484dc0c155';
		cleanups.push(registerIykeIframe(full, fakeIframe(), 'html-frame'));
		expect(resolveIframePaneId('ed002673')).toBe(full);
		// getIframe (used by isIframePane) now works with the short id too
		expect(getIframe('ed002673')?.paneId).toBe(full);
	});

	it('prefers an exact match', () => {
		const a = 'ed002673-072d-48ea-8772-b2484dc0c155';
		cleanups.push(registerIykeIframe(a, fakeIframe(), 'html-frame'));
		expect(resolveIframePaneId(a)).toBe(a);
	});

	it('returns undefined for an ambiguous prefix', () => {
		const a = 'ed002673-aaaa-48ea-8772-b2484dc0c155';
		const b = 'ed002673-bbbb-48ea-8772-b2484dc0c155';
		cleanups.push(registerIykeIframe(a, fakeIframe(), 'html-frame'));
		cleanups.push(registerIykeIframe(b, fakeIframe(), 'html-frame'));
		expect(resolveIframePaneId('ed002673')).toBeUndefined();
		expect(getIframe('ed002673')).toBeUndefined();
	});

	it('returns undefined when nothing matches', () => {
		cleanups.push(registerIykeIframe('abc12345-0000', fakeIframe(), 'html-frame'));
		expect(resolveIframePaneId('zzzz')).toBeUndefined();
	});
});
