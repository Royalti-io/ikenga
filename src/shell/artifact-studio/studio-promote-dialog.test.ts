import { describe, expect, it } from 'vitest';
import { promoteToFolder } from './studio-promote-dialog';

const SAMPLE_HTML = `<!doctype html>
<html>
<head>
\t<meta charset="utf-8">
\t<style>
\t\tbody { background: #111; }
\t</style>
\t<script type="application/json" id="ikenga-manifest">{"id":"x"}</script>
\t<script type="application/json" id="ikenga-mock-data">{"rows":[1,2,3]}</script>
</head>
<body>
\t<div id="app"></div>
\t<script type="text/babel">
\t\tconst App = () => <div>hi</div>;
\t\tReactDOM.render(<App />, document.getElementById('app'));
\t</script>
</body>
</html>`;

const SAMPLE_MANIFEST = {
	format: 'ikenga-artifact' as const,
	formatVersion: '0.1',
	id: 'my-art',
	name: 'My Artifact',
	version: '1.0.0',
	dataSources: {},
	fallback: { mode: 'mock' as const, dataTag: 'ikenga-mock-data' },
};

const ALL_OPTIONS = {
	splitCss: true,
	splitJsx: true,
	extractMockData: true,
	copyLinkedImages: false,
};

describe('promoteToFolder', () => {
	it('extracts CSS, JSX, and mock data when all options on', () => {
		const r = promoteToFolder({
			source: SAMPLE_HTML,
			options: ALL_OPTIONS,
			manifest: SAMPLE_MANIFEST,
		});

		expect(r.stylesCss).toContain('body { background: #111;');
		expect(r.appJsx).toContain('const App = ()');
		expect(r.mockJson).toBe('{"rows":[1,2,3]}');

		// HTML now references the split files and no longer contains inline blocks.
		expect(r.html).toContain('href="assets/styles.css"');
		expect(r.html).toContain('src="assets/app.jsx"');
		expect(r.html).toContain('src="assets/mock.json"');
		expect(r.html).not.toMatch(/<style[^>]*>[\s\S]+<\/style>/);
		expect(r.html).not.toMatch(/<script[^>]*type="text\/babel"[^>]*>[\s\S]+<\/script>/);
	});

	it('strips the inline manifest and emits manifest.json with entry set', () => {
		const r = promoteToFolder({
			source: SAMPLE_HTML,
			options: ALL_OPTIONS,
			manifest: SAMPLE_MANIFEST,
		});
		expect(r.html).not.toContain('id="ikenga-manifest"');
		const parsed = JSON.parse(r.manifestJson);
		expect(parsed.entry).toBe('index.html');
		expect(parsed.id).toBe('my-art');
	});

	it('switches fallback.dataTag → fallback.data when extracting mock data', () => {
		const r = promoteToFolder({
			source: SAMPLE_HTML,
			options: ALL_OPTIONS,
			manifest: SAMPLE_MANIFEST,
		});
		const parsed = JSON.parse(r.manifestJson);
		expect(parsed.fallback.data).toBe('assets/mock.json');
		expect(parsed.fallback.dataTag).toBeUndefined();
	});

	it('respects options: only splits what the user asked for', () => {
		const r = promoteToFolder({
			source: SAMPLE_HTML,
			options: { splitCss: false, splitJsx: true, extractMockData: false, copyLinkedImages: false },
			manifest: SAMPLE_MANIFEST,
		});
		expect(r.stylesCss).toBeNull();
		expect(r.appJsx).not.toBeNull();
		expect(r.mockJson).toBeNull();
		// HTML keeps the unsplit blocks.
		expect(r.html).toMatch(/<style[^>]*>/);
		expect(r.html).toContain('id="ikenga-mock-data"');
	});

	it('emits a template manifest when input is null', () => {
		const r = promoteToFolder({ source: SAMPLE_HTML, options: ALL_OPTIONS, manifest: null });
		const parsed = JSON.parse(r.manifestJson);
		expect(parsed.entry).toBe('index.html');
		expect(parsed.format).toBe('ikenga-artifact');
	});

	it('is a pure function', () => {
		const a = promoteToFolder({
			source: SAMPLE_HTML,
			options: ALL_OPTIONS,
			manifest: SAMPLE_MANIFEST,
		});
		const b = promoteToFolder({
			source: SAMPLE_HTML,
			options: ALL_OPTIONS,
			manifest: SAMPLE_MANIFEST,
		});
		expect(a).toEqual(b);
	});
});
