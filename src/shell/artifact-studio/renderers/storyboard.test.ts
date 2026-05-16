import { describe, expect, it } from 'vitest';
import { parseStoryboard } from './storyboard';

describe('parseStoryboard', () => {
	it('parses a well-formed storyboard with all fields', () => {
		const doc = parseStoryboard(
			JSON.stringify({
				title: 'Q2 promo',
				frames: [
					{ title: 'Open', image: '/a.png', voiceover: 'Welcome', durationMs: 1200 },
					{ title: 'Beat', image: '/b.png' },
				],
			})
		);
		expect(doc).not.toBeNull();
		expect(doc?.title).toBe('Q2 promo');
		expect(doc?.frames).toHaveLength(2);
		expect(doc?.frames[0]).toEqual({
			title: 'Open',
			image: '/a.png',
			voiceover: 'Welcome',
			durationMs: 1200,
		});
	});

	it('returns null on invalid JSON', () => {
		expect(parseStoryboard('not json')).toBeNull();
	});

	it('returns null when `frames` is missing', () => {
		expect(parseStoryboard('{}')).toBeNull();
	});

	it('returns null when `frames` is not an array', () => {
		expect(parseStoryboard(JSON.stringify({ frames: 'oops' }))).toBeNull();
	});

	it('drops malformed frames (non-objects) without erroring', () => {
		const doc = parseStoryboard(
			JSON.stringify({
				frames: [null, 'oops', { title: 'ok' }, 42],
			})
		);
		expect(doc?.frames).toHaveLength(1);
		expect(doc?.frames[0].title).toBe('ok');
	});

	it('coerces field types — drops non-strings silently', () => {
		const doc = parseStoryboard(
			JSON.stringify({
				frames: [{ title: 42, image: '/a.png', durationMs: 'fast' }],
			})
		);
		expect(doc?.frames[0]).toEqual({
			title: undefined,
			image: '/a.png',
			voiceover: undefined,
			durationMs: undefined,
		});
	});
});
