import { describe, expect, it } from 'vitest';
import { computeVersions, nextVariantName, versionStem } from './version-strip';
import type { FileEntry } from '@/lib/tauri-cmd';

function fe(path: string, opts: Partial<FileEntry> = {}): FileEntry {
	const name = path.split('/').pop() ?? path;
	return {
		path,
		name,
		isDir: opts.isDir ?? false,
		size: opts.size ?? 100,
		modifiedMs: opts.modifiedMs ?? 0,
	};
}

describe('computeVersions', () => {
	const canonical = '/work/marketing-q2/cfo-daily.html';

	it('returns just the canonical when there are no siblings', () => {
		const out = computeVersions(canonical, [fe(canonical)], []);
		expect(out).toHaveLength(1);
		expect(out[0].isCanonical).toBe(true);
	});

	it('picks up `<basename>-vN.html` siblings in the same dir', () => {
		const out = computeVersions(
			canonical,
			[
				fe(canonical, { modifiedMs: 1 }),
				fe('/work/marketing-q2/cfo-daily-v2.html', { modifiedMs: 5 }),
				fe('/work/marketing-q2/cfo-daily-v3.html', { modifiedMs: 10 }),
				fe('/work/marketing-q2/other.html', { modifiedMs: 8 }),
			],
			[]
		);
		expect(out.map((v) => v.name)).toEqual([
			'cfo-daily.html',
			'cfo-daily-v3.html',
			'cfo-daily-v2.html',
		]);
	});

	it('picks up variants inside `<basename>/` subdir', () => {
		const out = computeVersions(
			canonical,
			[fe(canonical)],
			[
				fe('/work/marketing-q2/cfo-daily/v2.html', { modifiedMs: 100 }),
				fe('/work/marketing-q2/cfo-daily/v3-dark.html', { modifiedMs: 200 }),
			]
		);
		expect(out.map((v) => v.name)).toEqual(['cfo-daily.html', 'v3-dark.html', 'v2.html']);
	});

	it('ignores entries with a non-matching extension', () => {
		const out = computeVersions(
			canonical,
			[
				fe(canonical),
				fe('/work/marketing-q2/cfo-daily.md'),
				fe('/work/marketing-q2/cfo-daily.pdf'),
			],
			[]
		);
		expect(out).toHaveLength(1);
	});

	it('ignores directories in the parent listing', () => {
		const out = computeVersions(
			canonical,
			[
				fe(canonical),
				fe('/work/marketing-q2/cfo-daily', { isDir: true }),
				fe('/work/marketing-q2/cfo-daily-archive', { isDir: true }),
			],
			[]
		);
		expect(out).toHaveLength(1);
	});

	it('deduplicates when a sibling shows up in both lists', () => {
		const out = computeVersions(
			canonical,
			[fe(canonical), fe('/work/marketing-q2/cfo-daily-v2.html', { modifiedMs: 5 })],
			[fe('/work/marketing-q2/cfo-daily-v2.html', { modifiedMs: 5 })]
		);
		expect(out).toHaveLength(2);
		expect(out[1].name).toBe('cfo-daily-v2.html');
	});

	it('opening a variant directly still surfaces the canonical + siblings', () => {
		const out = computeVersions(
			'/work/marketing-q2/cfo-daily-v2.html',
			[
				fe('/work/marketing-q2/cfo-daily.html', { modifiedMs: 1 }),
				fe('/work/marketing-q2/cfo-daily-v2.html', { modifiedMs: 5 }),
				fe('/work/marketing-q2/cfo-daily-v3.html', { modifiedMs: 10 }),
			],
			[]
		);
		expect(out[0].name).toBe('cfo-daily.html');
		expect(out[0].isCanonical).toBe(true);
		expect(out.map((v) => v.name)).toEqual([
			'cfo-daily.html',
			'cfo-daily-v3.html',
			'cfo-daily-v2.html',
		]);
	});

	it('picks up `_N` siblings alongside `-vN`', () => {
		const out = computeVersions(
			canonical,
			[
				fe(canonical, { modifiedMs: 1 }),
				fe('/work/marketing-q2/cfo-daily_1.html', { modifiedMs: 5 }),
				fe('/work/marketing-q2/cfo-daily_2.html', { modifiedMs: 10 }),
				fe('/work/marketing-q2/cfo-daily-v2.html', { modifiedMs: 7 }),
			],
			[]
		);
		expect(out.map((v) => v.name)).toEqual([
			'cfo-daily.html',
			'cfo-daily_2.html',
			'cfo-daily-v2.html',
			'cfo-daily_1.html',
		]);
	});

	it('includes -vN-descriptor variants like `cfo-daily-v3-dark.html`', () => {
		const out = computeVersions(
			canonical,
			[
				fe(canonical, { modifiedMs: 1 }),
				fe('/work/marketing-q2/cfo-daily-v3-dark.html', { modifiedMs: 10 }),
			],
			[]
		);
		expect(out.map((v) => v.name)).toEqual(['cfo-daily.html', 'cfo-daily-v3-dark.html']);
	});

	it('does NOT pull in unrelated files that happen to share a prefix', () => {
		// Before the stem-based match this would mis-match `cfo-daily-archive.html`
		// because the basename startsWith `cfo-daily`.
		const out = computeVersions(
			canonical,
			[
				fe(canonical),
				fe('/work/marketing-q2/cfo-daily-archive.html', { modifiedMs: 5 }),
				fe('/work/marketing-q2/cfo-dailyish.html', { modifiedMs: 5 }),
			],
			[]
		);
		expect(out).toHaveLength(1);
		expect(out[0].name).toBe('cfo-daily.html');
	});
});

describe('versionStem', () => {
	it('strips -vN', () => {
		expect(versionStem('foo-v2')).toBe('foo');
		expect(versionStem('foo-v10')).toBe('foo');
	});
	it('strips _N', () => {
		expect(versionStem('foo_1')).toBe('foo');
		expect(versionStem('foo_42')).toBe('foo');
	});
	it('strips -vN-descriptor', () => {
		expect(versionStem('foo-v3-dark')).toBe('foo');
		expect(versionStem('foo-v2-2026-05-18')).toBe('foo');
	});
	it('leaves non-version basenames untouched', () => {
		expect(versionStem('foo')).toBe('foo');
		expect(versionStem('foo-bar')).toBe('foo-bar');
		expect(versionStem('foo-daily')).toBe('foo-daily');
	});
});

describe('nextVariantName', () => {
	it('picks v2 when no variant exists', () => {
		expect(nextVariantName('cfo-daily.html', ['cfo-daily.html'])).toBe('cfo-daily-v2.html');
	});

	it('skips taken slots in sequence', () => {
		expect(
			nextVariantName('cfo-daily.html', [
				'cfo-daily.html',
				'cfo-daily-v2.html',
				'cfo-daily-v3.html',
			])
		).toBe('cfo-daily-v4.html');
	});

	it('roots against the family when the canonical itself is a variant', () => {
		expect(nextVariantName('cfo-daily-v2.html', ['cfo-daily.html', 'cfo-daily-v2.html'])).toBe(
			'cfo-daily-v3.html'
		);
	});

	it('preserves extension when present', () => {
		expect(nextVariantName('deck.deck.html', ['deck.deck.html'])).toBe('deck.deck-v2.html');
	});

	it('handles files with no extension', () => {
		expect(nextVariantName('cfo-daily', ['cfo-daily'])).toBe('cfo-daily-v2');
	});
});
