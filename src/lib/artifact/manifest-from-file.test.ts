import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/tauri-cmd', () => ({
	fsRead: vi.fn(),
}));

import { fsRead } from '@/lib/tauri-cmd';
import {
	extractManifestJson,
	parseManifestPreviewFromHtml,
	readManifestPreview,
} from './manifest-from-file';

describe('extractManifestJson', () => {
	it('finds the script body with double-quoted attributes', () => {
		const html = `<head><script type="application/json" id="ikenga-manifest">{"id":"x"}</script></head>`;
		expect(extractManifestJson(html)).toBe('{"id":"x"}');
	});

	it('finds the script body with single-quoted attributes', () => {
		const html = `<script type='application/json' id='ikenga-manifest'>{"id":"y"}</script>`;
		expect(extractManifestJson(html)).toBe('{"id":"y"}');
	});

	it('handles attributes in any order', () => {
		const html = `<script id="ikenga-manifest" type="application/json">{"id":"z"}</script>`;
		expect(extractManifestJson(html)).toBe('{"id":"z"}');
	});

	it('strips surrounding whitespace inside the script body', () => {
		const html = `<script id="ikenga-manifest">\n  {"id":"w"}\n</script>`;
		expect(extractManifestJson(html)).toBe('{"id":"w"}');
	});

	it('returns null when the script tag is missing', () => {
		expect(extractManifestJson('<html><body>hi</body></html>')).toBeNull();
	});

	it('returns null when the script tag is empty', () => {
		const html = `<script id="ikenga-manifest"></script>`;
		expect(extractManifestJson(html)).toBeNull();
	});

	it('does not match unrelated script tags', () => {
		const html = `<script id="other">{"id":"x"}</script>`;
		expect(extractManifestJson(html)).toBeNull();
	});
});

describe('parseManifestPreviewFromHtml', () => {
	it('parses the projected fields', () => {
		const html = `<script id="ikenga-manifest">${JSON.stringify({
			id: 'cfo-daily',
			name: 'CFO Daily',
			description: 'Daily finance digest',
			icon: { lucide: 'banknote' },
			pin: { suggested: true, section: 'Finance' },
		})}</script>`;
		expect(parseManifestPreviewFromHtml(html)).toEqual({
			id: 'cfo-daily',
			name: 'CFO Daily',
			description: 'Daily finance digest',
			icon: { lucide: 'banknote' },
			pin: { suggested: true, section: 'Finance' },
		});
	});

	it('returns null on malformed JSON', () => {
		const html = `<script id="ikenga-manifest">{not json}</script>`;
		expect(parseManifestPreviewFromHtml(html)).toBeNull();
	});

	it('returns null when the parsed value is not an object', () => {
		const html = `<script id="ikenga-manifest">"just a string"</script>`;
		expect(parseManifestPreviewFromHtml(html)).toBeNull();
	});

	it('returns null when no manifest tag is present', () => {
		expect(parseManifestPreviewFromHtml('<p>not an artifact</p>')).toBeNull();
	});
});

describe('readManifestPreview', () => {
	it('returns the parsed preview on a happy path', async () => {
		const html = `<script id="ikenga-manifest">{"id":"hello","name":"Hello"}</script>`;
		vi.mocked(fsRead).mockResolvedValueOnce({
			bytes: Array.from(new TextEncoder().encode(html)),
			mime: 'text/html',
		});
		const preview = await readManifestPreview('/tmp/x.html');
		expect(preview).toEqual({ id: 'hello', name: 'Hello' });
	});

	it('returns null when fsRead throws', async () => {
		vi.mocked(fsRead).mockRejectedValueOnce(new Error('ENOENT'));
		const preview = await readManifestPreview('/missing');
		expect(preview).toBeNull();
	});

	it('returns null when the file has no manifest tag', async () => {
		vi.mocked(fsRead).mockResolvedValueOnce({
			bytes: Array.from(new TextEncoder().encode('<p>plain html</p>')),
			mime: 'text/html',
		});
		expect(await readManifestPreview('/tmp/plain.html')).toBeNull();
	});

	it('handles non-UTF8-clean bytes without throwing', async () => {
		// Garbage byte 0xff — TextDecoder with fatal:false replaces it.
		vi.mocked(fsRead).mockResolvedValueOnce({
			bytes: [0xff, 0xfe, 0x00],
			mime: 'application/octet-stream',
		});
		expect(await readManifestPreview('/tmp/binary')).toBeNull();
	});
});
