import { describe, expect, it } from 'vitest';
import { extractManifestJson } from './manifest-from-file';
import { writeManifestIntoHtml } from './manifest-write';

const MIN_MANIFEST = {
	format: 'ikenga-artifact' as const,
	formatVersion: '0.1',
	id: 'hello',
	name: 'Hello',
	version: '1.0.0',
	dataSources: {},
	fallback: { mode: 'mock' as const, dataTag: 'ikenga-mock-data' },
};

describe('writeManifestIntoHtml', () => {
	it('replaces only the body of an existing manifest tag', () => {
		const before = `<head>
\t<script type="application/json" id="ikenga-manifest">
{"id":"old"}
\t</script>
\t<title>X</title>
</head>`;
		const after = writeManifestIntoHtml(before, MIN_MANIFEST);
		// The new JSON is present and the old is gone.
		expect(after).toContain('"id": "hello"');
		expect(after).not.toContain('"id":"old"');
		// Surrounding markup is untouched.
		expect(after).toContain('<title>X</title>');
		expect(after).toContain('type="application/json"');
	});

	it('round-trips through extractManifestJson', () => {
		const before = `<head><script id="ikenga-manifest" type="application/json">{}</script></head>`;
		const after = writeManifestIntoHtml(before, MIN_MANIFEST);
		const extracted = extractManifestJson(after);
		expect(extracted).not.toBeNull();
		expect(JSON.parse(extracted as string)).toEqual(MIN_MANIFEST);
	});

	it('preserves single-quoted attributes when round-tripping', () => {
		const before = `<script id='ikenga-manifest' type='application/json'>{"id":"old"}</script>`;
		const after = writeManifestIntoHtml(before, MIN_MANIFEST);
		// Attribute quoting style is unchanged.
		expect(after).toContain(`id='ikenga-manifest'`);
		expect(after).toContain(`type='application/json'`);
		expect(after).toContain('"id": "hello"');
	});

	it('inserts a new tag into <head> when none exists', () => {
		const before = `<!doctype html>
<html>
<head>
	<meta charset="utf-8">
</head>
<body></body>
</html>`;
		const after = writeManifestIntoHtml(before, MIN_MANIFEST);
		expect(extractManifestJson(after)).not.toBeNull();
		// New tag is placed inside <head>, before </head>.
		const headSlice = after.slice(after.indexOf('<head'), after.indexOf('</head>'));
		expect(headSlice).toContain('id="ikenga-manifest"');
	});

	it('falls back to inserting before </html> when there is no head', () => {
		const before = `<html><body>hi</body></html>`;
		const after = writeManifestIntoHtml(before, MIN_MANIFEST);
		expect(extractManifestJson(after)).not.toBeNull();
		expect(after.indexOf('id="ikenga-manifest"')).toBeLessThan(after.indexOf('</html>'));
	});

	it('appends a new tag when the document is completely malformed', () => {
		const before = `<body>orphan</body>`;
		const after = writeManifestIntoHtml(before, MIN_MANIFEST);
		expect(extractManifestJson(after)).not.toBeNull();
		expect(after.startsWith('<body>orphan</body>')).toBe(true);
	});

	it('is a pure function — same input, same output', () => {
		const before = `<script id="ikenga-manifest" type="application/json">{}</script>`;
		const a = writeManifestIntoHtml(before, MIN_MANIFEST);
		const b = writeManifestIntoHtml(before, MIN_MANIFEST);
		expect(a).toBe(b);
	});
});
