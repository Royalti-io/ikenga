import { afterEach, describe, expect, it, vi } from 'vitest';

import { clampScale, isUnwalkableIframe, MAX_CAPTURE_PIXELS } from './screenshot';

function setDpr(dpr: number) {
	Object.defineProperty(window, 'devicePixelRatio', {
		value: dpr,
		configurable: true,
	});
}

afterEach(() => {
	setDpr(1);
	vi.restoreAllMocks();
});

describe('clampScale', () => {
	it('returns the full devicePixelRatio for normal-sized windows', () => {
		setDpr(2);
		// 1440x900 @ 2x = 2.6M px, well under the 16M budget.
		expect(clampScale(1440, 900)).toBe(2);
	});

	it('clamps below dpr and stays within the pixel budget for HiDPI windows', () => {
		// CSS area 6M px is under the budget; at dpr 3 the naive device area
		// would be 54M, so the clamp must bite and pull scale below 3.
		setDpr(3);
		const w = 3000;
		const h = 2000;
		const scale = clampScale(w, h);
		expect(scale).toBeLessThan(3);
		expect(scale).toBeGreaterThanOrEqual(1);
		expect(w * h * scale * scale).toBeLessThanOrEqual(MAX_CAPTURE_PIXELS + 1);
	});

	it('never returns less than 1', () => {
		setDpr(0.5);
		expect(clampScale(10000, 10000)).toBeGreaterThanOrEqual(1);
	});

	it('treats zero dimensions safely (no divide-by-zero / NaN)', () => {
		setDpr(2);
		const scale = clampScale(0, 0);
		expect(Number.isFinite(scale)).toBe(true);
		expect(scale).toBeGreaterThanOrEqual(1);
	});
});

describe('isUnwalkableIframe', () => {
	it('returns false for a non-iframe element', () => {
		const div = document.createElement('div');
		expect(isUnwalkableIframe(div)).toBe(false);
	});

	it('returns false for a same-origin iframe with a reachable document', () => {
		const iframe = {
			tagName: 'IFRAME',
			contentDocument: document.implementation.createHTMLDocument('x'),
			contentWindow: { location: { href: 'http://localhost/' } },
		} as unknown as Element;
		expect(isUnwalkableIframe(iframe)).toBe(false);
	});

	it('returns true when contentDocument is null (not loaded / blocked)', () => {
		const iframe = {
			tagName: 'IFRAME',
			contentDocument: null,
			contentWindow: null,
		} as unknown as Element;
		expect(isUnwalkableIframe(iframe)).toBe(true);
	});

	it('returns true when touching the frame location throws (cross-origin)', () => {
		const iframe = {
			tagName: 'IFRAME',
			contentDocument: {},
			get contentWindow(): Window {
				throw new DOMException('cross-origin', 'SecurityError');
			},
		} as unknown as Element;
		expect(isUnwalkableIframe(iframe)).toBe(true);
	});
});
