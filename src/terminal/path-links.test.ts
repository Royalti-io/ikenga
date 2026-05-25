import { describe, expect, it } from 'vitest';
import { scanLineForPaths } from './path-links';

describe('scanLineForPaths', () => {
	it('finds an absolute path with a known extension', () => {
		const line = '› [image] /tmp/v1-list-detail.png (145.3KB)';
		const spans = scanLineForPaths(line);
		expect(spans).toHaveLength(1);
		expect(spans[0].text).toBe('/tmp/v1-list-detail.png');
		// 1-based inclusive cell columns
		const start = line.indexOf('/tmp');
		expect(spans[0].startX).toBe(start + 1);
		expect(spans[0].endX).toBe(start + '/tmp/v1-list-detail.png'.length);
	});

	it('finds a relative source path', () => {
		const spans = scanLineForPaths('edited src/foo/bar.ts and src/baz.tsx');
		expect(spans.map((s) => s.text)).toEqual(['src/foo/bar.ts', 'src/baz.tsx']);
	});

	it('strips surrounding parens and trailing punctuation', () => {
		const spans = scanLineForPaths('see (/tmp/out.png), then done.');
		expect(spans).toHaveLength(1);
		expect(spans[0].text).toBe('/tmp/out.png');
	});

	it('strips a :line:col suffix', () => {
		const spans = scanLineForPaths('  at src/index.ts:42:7');
		expect(spans).toHaveLength(1);
		expect(spans[0].text).toBe('src/index.ts');
	});

	it('ignores URLs and prose', () => {
		expect(scanLineForPaths('visit https://example.com/x.png now')).toHaveLength(0);
		expect(scanLineForPaths('e.g. this is fine, Mr.A')).toHaveLength(0);
	});

	it('ignores a single-segment token with an unknown extension', () => {
		expect(scanLineForPaths('build finished in 1.234s')).toHaveLength(0);
	});
});
