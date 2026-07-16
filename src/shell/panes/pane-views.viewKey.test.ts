// Regression guard for the dock "+" terminal-duplication bug.
//
// The dock renders only its active tab through a single PaneBody. That element
// is keyed by `viewKey(view)`, so distinct sessions get distinct React
// instances and a freshly-created terminal remounts instead of reusing the
// previous SingleTerminal (which kept showing the old PTY). The load-bearing
// invariant: distinct sessions ⇒ distinct keys.

import { describe, expect, it } from 'vitest';

import type { LeafNode, PaneView } from '@/lib/panes/types';
import { addTab, closeTab, makeLeaf, reorderTab, switchTab } from '@/lib/panes/pane-reducer';
import { tabUid, viewKey } from './view-key';

describe('viewKey', () => {
	it('gives two terminals with different sessionIds different keys', () => {
		const a: PaneView = { kind: 'terminal', sessionId: 'sess-aaaa' };
		const b: PaneView = { kind: 'terminal', sessionId: 'sess-bbbb' };
		expect(viewKey(a)).not.toBe(viewKey(b));
	});

	it('kind-prefixes so a terminal and a chat sharing an id never collide', () => {
		const t: PaneView = { kind: 'terminal', sessionId: 'same-id' };
		const c: PaneView = { kind: 'chat', sessionId: 'same-id' };
		expect(viewKey(t)).not.toBe(viewKey(c));
	});

	it('is stable for the same view shape', () => {
		const v: PaneView = { kind: 'terminal', sessionId: 'sess-aaaa' };
		expect(viewKey(v)).toBe(viewKey({ kind: 'terminal', sessionId: 'sess-aaaa' }));
	});

	it('collides for two distinct tabs holding identical content (the gap tabUid closes)', () => {
		const a: PaneView = { kind: 'route', path: '/settings' };
		const b: PaneView = { kind: 'route', path: '/settings' };
		expect(viewKey(a)).toBe(viewKey(b));
	});
});

// Regression guard for the pane.tsx / route-view.tsx remount-hygiene fix
// (Wave 3, review §1 remedy 3): PaneBody and the per-pane router cache key
// by `tabUid`, not `viewKey` or `activeTabIdx`, because two tabs in one
// pane can share identical content (viewKey collision above) and a tab's
// index shifts on reorder/sibling-close even though it's the same tab.
describe('tabUid', () => {
	it('is stable for the same object across repeated calls', () => {
		const v: PaneView = { kind: 'route', path: '/a' };
		expect(tabUid(v)).toBe(tabUid(v));
	});

	it('gives two structurally-identical views distinct ids, unlike viewKey', () => {
		const a: PaneView = { kind: 'route', path: '/settings' };
		const b: PaneView = { kind: 'route', path: '/settings' };
		expect(tabUid(a)).not.toBe(tabUid(b));
	});

	it('survives a reorder — the moved tab keeps its id, not its old index', () => {
		const leaf = makeLeaf({ kind: 'route', path: '/a' });
		const withSecond = addTab(leaf, leaf.id, { kind: 'route', path: '/b' }) as LeafNode;
		const idBefore = tabUid(withSecond.tabs[0]);
		const reordered = reorderTab(withSecond, leaf.id, 0, 1) as LeafNode;
		const moved = reordered.tabs.find((t) => (t as { path: string }).path === '/a')!;
		expect(tabUid(moved)).toBe(idBefore);
	});

	it('survives closing a lower-indexed sibling — the remaining active tab keeps its id', () => {
		const leaf = makeLeaf({ kind: 'route', path: '/x' });
		const withSecond = addTab(leaf, leaf.id, { kind: 'route', path: '/keep' }) as LeafNode;
		const switched = switchTab(withSecond, leaf.id, 1) as LeafNode; // active tab is now /keep
		const idBefore = tabUid(switched.tabs[switched.activeTabIdx]);
		const r = closeTab(switched, leaf.id, 0, leaf.id); // close /x, the lower-indexed sibling
		const after = r.root as LeafNode;
		expect(tabUid(after.tabs[after.activeTabIdx])).toBe(idBefore);
	});
});
