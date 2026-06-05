// modeForRoute — route → owning activity mode.

import { describe, expect, it } from 'vitest';

import { modeForRoute } from './mode-routes';

describe('modeForRoute', () => {
	it('maps the exclusive CORE-mode prefixes', () => {
		expect(modeForRoute('/packages')).toBe('pkgs');
		expect(modeForRoute('/packages/browse')).toBe('pkgs');
		expect(modeForRoute('/packages?filter=review')).toBe('pkgs');
		expect(modeForRoute('/claude')).toBe('ngwa');
		expect(modeForRoute('/settings/appearance')).toBe('settings');
	});

	it('maps a pkg route to that pkg’s own mode', () => {
		expect(modeForRoute('/pkg/com.ikenga.tasks/')).toBe('pkg:com.ikenga.tasks');
		expect(modeForRoute('/pkg/com.ikenga.suite/sub/path')).toBe('pkg:com.ikenga.suite');
		// Query strings / hashes don't change the owning pkg.
		expect(modeForRoute('/pkg/com.ikenga.tasks/?view=triage')).toBe('pkg:com.ikenga.tasks');
	});

	it('returns null for routes shared across modes', () => {
		expect(modeForRoute('/')).toBeNull();
		expect(modeForRoute('/sessions')).toBeNull();
		expect(modeForRoute('/todos')).toBeNull();
		// Lookalike sibling must not match an exclusive prefix.
		expect(modeForRoute('/packages-foo')).toBeNull();
	});
});
