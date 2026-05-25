// Regression guard for the dock "+" terminal-duplication bug.
//
// The dock renders only its active tab through a single PaneBody. That element
// is keyed by `viewKey(view)`, so distinct sessions get distinct React
// instances and a freshly-created terminal remounts instead of reusing the
// previous SingleTerminal (which kept showing the old PTY). The load-bearing
// invariant: distinct sessions ⇒ distinct keys.

import { describe, expect, it } from 'vitest';

import type { PaneView } from '@/lib/panes/types';
import { viewKey } from './view-key';

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
});
