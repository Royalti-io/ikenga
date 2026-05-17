// Tests for the pure helpers behind <PkgThumb>. The component itself isn't
// rendered here — the shell's vitest setup has no DOM environment (see the
// note in onboarding/wizard-stepper.test.tsx). What we can verify cheaply
// is that the empty-state identity is deterministic per pkg id, so a pkg
// always paints with the same warm/teal/gold/coral/plum/sage tint, and
// that kind→icon mapping covers every known manifest kind.

import { describe, expect, it } from 'vitest';
import { Bolt, Box, Cog, Package, Workflow } from 'lucide-react';

import { TINT_PALETTE, iconForKind, tintFor } from './pkg-thumb';

describe('tintFor', () => {
	it('is deterministic for a given id', () => {
		const a1 = tintFor('com.ikenga.iyke');
		const a2 = tintFor('com.ikenga.iyke');
		expect(a1).toEqual(a2);
	});

	it('returns a TintColors from the palette', () => {
		const c = tintFor('com.test.x');
		expect(TINT_PALETTE).toContainEqual(c);
		// All three fields are HSL strings — guards against future palette
		// edits that accidentally drop one field on a row.
		expect(c.bg).toMatch(/^hsl\(/);
		expect(c.ring).toMatch(/^hsl\(/);
		expect(c.fg).toMatch(/^hsl\(/);
	});

	it('uses the full palette over a varied id set', () => {
		// 24 fixture ids mirror real pkg id shapes; we expect to see at least
		// half of the palette colors used across them (deterministic but
		// distributed). Lets us catch accidental collapse to one tint.
		const ids = [
			'com.ikenga.iyke',
			'com.ikenga.mcp-iyke',
			'com.ikenga.engine-claude-code',
			'com.ikenga.engine-noop',
			'com.ikenga.engine-codex',
			'com.ikenga.engine-gemini',
			'com.ikenga.email',
			'com.ikenga.work',
			'com.ikenga.finance',
			'com.ikenga.gtm',
			'com.ikenga.product',
			'com.ikenga.exec',
			'com.royalti.storyboard',
			'com.royalti.video-studio',
			'com.royalti.hyperframes',
			'com.royalti.content',
			'com.royalti.ddex',
			'com.test.a',
			'com.test.b',
			'com.test.c',
			'@ikenga/mcp-browser',
			'@ikenga/pkg-engine-claude-code',
			'@ikenga/pkg-hello',
			'@third/scheduler',
		];
		const seen = new Set(ids.map((id) => tintFor(id).bg));
		expect(seen.size).toBeGreaterThanOrEqual(TINT_PALETTE.length / 2);
	});

	it('handles the empty id without throwing', () => {
		// Edge case — empty id should still produce a valid tint, not blow up.
		const c = tintFor('');
		expect(TINT_PALETTE).toContainEqual(c);
	});

	it('does not depend on case (different id chars → different tint)', () => {
		// Not a strict requirement, just a sanity check that the hash mixes
		// characters — `com.x` and `com.y` should not collapse to the same tint
		// for every adjacent pair.
		expect(tintFor('com.x')).not.toEqual(tintFor('com.y'));
	});
});

describe('iconForKind', () => {
	it('maps engine → Bolt', () => {
		expect(iconForKind('engine')).toBe(Bolt);
	});
	it('maps mcp → Workflow', () => {
		expect(iconForKind('mcp')).toBe(Workflow);
	});
	it('maps skill → Cog', () => {
		expect(iconForKind('skill')).toBe(Cog);
	});
	it('maps embedded → Box', () => {
		expect(iconForKind('embedded')).toBe(Box);
	});
	it('falls back to Package for unknown kinds (including the default `ui`)', () => {
		expect(iconForKind('ui')).toBe(Package);
		expect(iconForKind('whatever-new-kind')).toBe(Package);
		expect(iconForKind('')).toBe(Package);
	});
});
