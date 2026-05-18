import { describe, expect, it } from 'vitest';
import { deriveSelectorFromNode, type SelectorNode } from './selector';

// Build a node + immediately link parent. Used to assemble fixture trees by
// hand — `parentChildren` is patched once all siblings exist so each child
// can disambiguate among its own row.
function mkNode(
	tag: string,
	opts: { id?: string; classes?: string[]; parent?: SelectorNode } = {}
): SelectorNode {
	return {
		id: opts.id ?? '',
		tagName: tag.toLowerCase(),
		classNames: opts.classes ?? [],
		parent: opts.parent ?? null,
		parentChildren: [],
	};
}

function linkChildren(parent: SelectorNode, children: SelectorNode[]) {
	for (const c of children) {
		c.parent = parent;
		c.parentChildren = children;
	}
}

describe('deriveSelectorFromNode', () => {
	it('prefers id when present', () => {
		const node = mkNode('div', { id: 'hero', classes: ['text-lg'] });
		expect(deriveSelectorFromNode(node)).toBe('div#hero');
	});

	it('uses ancestor id as anchor', () => {
		const section = mkNode('section', { id: 'sales' });
		const div = mkNode('div', { classes: ['row'] });
		const span = mkNode('span');
		linkChildren(section, [div]);
		linkChildren(div, [span]);
		expect(deriveSelectorFromNode(span)).toBe('section#sales > div.row > span');
	});

	it('drops Tailwind-style utility classes', () => {
		const section = mkNode('section', { id: 'sales' });
		const div = mkNode('div', { classes: ['row', 'text-lg', 'p-4', 'bg-amber-500'] });
		linkChildren(section, [div]);
		expect(deriveSelectorFromNode(div)).toBe('section#sales > div.row');
	});

	it('disambiguates siblings with nth-of-type', () => {
		const section = mkNode('section', { id: 'grid' });
		const c1 = mkNode('div', { classes: ['card'] });
		const c2 = mkNode('div', { classes: ['card'] });
		const c3 = mkNode('div', { classes: ['card'] });
		linkChildren(section, [c1, c2, c3]);
		expect(deriveSelectorFromNode(c2)).toBe('section#grid > div.card:nth-of-type(2)');
	});

	it('returns empty string for null input', () => {
		expect(deriveSelectorFromNode(null)).toBe('');
	});

	it('emits just the tag when there is no parent or id', () => {
		const orphan = mkNode('span');
		expect(deriveSelectorFromNode(orphan)).toBe('span');
	});

	it('walks to body when no anchor id is available', () => {
		const body = mkNode('body');
		const div = mkNode('div', { classes: ['row'] });
		const span = mkNode('span');
		linkChildren(body, [div]);
		linkChildren(div, [span]);
		expect(deriveSelectorFromNode(span)).toBe('body > div.row > span');
	});
});
