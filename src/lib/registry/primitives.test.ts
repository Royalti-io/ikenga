import { describe, expect, it } from 'vitest';

import type { ClaudeStoreEntry, RequiresEntry } from '@/lib/tauri-cmd';
import { resolveCatalogClosure, type PrimitiveCatalogEntry } from './primitives';

// ── fixtures ────────────────────────────────────────────────────────────────

function cat(
	name: string,
	requires?: RequiresEntry[],
	over?: Partial<PrimitiveCatalogEntry>
): PrimitiveCatalogEntry {
	return {
		kind: 'skill',
		name,
		version: '0.1.0',
		description: null,
		source: 'npx',
		url: `royalti-io/${name}`,
		publisher: 'royalti-io',
		...(requires ? { requires } : {}),
		...over,
	};
}

const ref = (name: string, extra?: Partial<RequiresEntry>): RequiresEntry => ({
	kind: 'skill',
	name,
	...extra,
});

const installed = (names: string[]): Set<string> =>
	new Set(names.map((n) => `skill:${n}`));

// resolveCatalogClosure only reads kind+name off store entries via installedKeys,
// so we never need a full ClaudeStoreEntry here — the Set is the contract.
const _storeShape: ClaudeStoreEntry[] = []; // type-only anchor
void _storeShape;

describe('resolveCatalogClosure (WP-15 consent surface)', () => {
	it('returns an empty closure for a dep-free primitive', () => {
		const t = cat('artifact-builder');
		expect(resolveCatalogClosure(t, [t], new Set())).toEqual([]);
	});

	it('resolves a catalogued dep with inherited trust (no extra confirm)', () => {
		const dep = cat('design-language');
		const t = cat('artifact-builder', [ref('design-language')]);
		const out = resolveCatalogClosure(t, [t, dep], new Set());
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({
			name: 'design-language',
			resolution: 'catalog',
			satisfied: false,
			needsExtraConfirm: false,
			provenance: 'npx · royalti-io/design-language',
		});
	});

	it('flags a self-pinned non-catalog dep as needing an extra confirm', () => {
		const t = cat('app', [ref('skill-core', { source: 'git', ref: 'v2' })]);
		const out = resolveCatalogClosure(t, [t], new Set());
		expect(out[0]).toMatchObject({
			name: 'skill-core',
			resolution: 'pinned',
			needsExtraConfirm: true,
			provenance: 'git @ v2 · not in catalog',
		});
	});

	it('flags an un-pinned non-catalog dep as unresolved + extra confirm', () => {
		const t = cat('app', [ref('mystery')]);
		const out = resolveCatalogClosure(t, [t], new Set());
		expect(out[0]).toMatchObject({
			name: 'mystery',
			resolution: 'unresolved',
			needsExtraConfirm: true,
		});
	});

	it('marks an already-installed dep satisfied (listed, not re-installed)', () => {
		const dep = cat('design-language');
		const t = cat('artifact-builder', [ref('design-language')]);
		const out = resolveCatalogClosure(t, [t, dep], installed(['design-language']));
		expect(out[0]).toMatchObject({ name: 'design-language', satisfied: true });
	});

	it('walks the transitive closure through catalogued parents', () => {
		const c = cat('c');
		const b = cat('b', [ref('c')]);
		const a = cat('a', [ref('b')]);
		const t = cat('app', [ref('a')]);
		const out = resolveCatalogClosure(t, [t, a, b, c], new Set());
		expect(out.map((d) => d.name)).toEqual(['a', 'b', 'c']);
	});

	it('dedupes a diamond dependency', () => {
		const d = cat('d');
		const b = cat('b', [ref('d')]);
		const c = cat('c', [ref('d')]);
		const t = cat('app', [ref('b'), ref('c')]);
		const out = resolveCatalogClosure(t, [t, b, c, d], new Set());
		expect(out.map((d) => d.name)).toEqual(['b', 'c', 'd']);
	});

	it('does not hang on a dependency cycle', () => {
		const a = cat('a', [ref('b')]);
		const b = cat('b', [ref('a')]);
		const t = cat('app', [ref('a')]);
		const out = resolveCatalogClosure(t, [t, a, b], new Set());
		expect(out.map((d) => d.name).sort()).toEqual(['a', 'b']);
	});
});
