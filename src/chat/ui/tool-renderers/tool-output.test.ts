import { describe, expect, it } from 'vitest';
import { extractOutput } from './tool-output-extract';

describe('extractOutput', () => {
	it('passes a plain string through as text', () => {
		expect(extractOutput('hello\nworld')).toEqual({ text: 'hello\nworld', images: [] });
	});

	it('extracts an Anthropic base64 image block (the raw_output shape)', () => {
		const out = extractOutput([
			{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
		]);
		expect(out.text).toBe('');
		expect(out.images).toEqual([{ src: 'data:image/png;base64,AAAA' }]);
	});

	it('extracts an ACP ImageContent block (the content channel shape)', () => {
		const out = extractOutput([{ type: 'image', data: 'BBBB', mimeType: 'image/jpeg' }]);
		expect(out.images).toEqual([{ src: 'data:image/jpeg;base64,BBBB' }]);
	});

	it('keeps text and images side by side', () => {
		const out = extractOutput([
			{ type: 'text', text: 'here is the chart' },
			{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'CCCC' } },
		]);
		expect(out.text).toBe('here is the chart');
		expect(out.images).toEqual([{ src: 'data:image/png;base64,CCCC' }]);
	});

	it('passes a url-sourced image through as a direct src', () => {
		const out = extractOutput([{ type: 'image', source: { type: 'url', url: 'https://x/y.png' } }]);
		expect(out.images).toEqual([{ src: 'https://x/y.png' }]);
	});

	it('pretty-prints an arbitrary object with no images', () => {
		const out = extractOutput({ ok: true, count: 2 });
		expect(out.images).toHaveLength(0);
		expect(out.text).toBe(JSON.stringify({ ok: true, count: 2 }, null, 2));
	});
});
