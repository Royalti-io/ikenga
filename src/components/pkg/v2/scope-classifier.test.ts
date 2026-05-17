// Exhaustive tests for the scope-classifier. Every rule in the RULES table
// needs at least one positive case here so refactors of the pattern list
// stay honest; representative high-risk patterns get extra coverage because
// they drive the install-sheet "Review write scopes" callout.

import { describe, expect, it } from 'vitest';

import { classifyScope, riskColor } from './scope-classifier';

describe('classifyScope', () => {
	describe('high risk', () => {
		it.each([
			['fs:write:workspace/storyboards', 'Write to disk'],
			['fs:write:.company/content', 'Write to disk'],
			['shell.execute:claude', 'Run binary'],
			['shell.execute:ffmpeg', 'Run binary'],
			['supabase:write:email_drafts', 'Write to Supabase'],
			['shell:engine:default', 'Acts as the engine adapter'],
		])('classifies %s as high', (scope, label) => {
			const c = classifyScope(scope);
			expect(c.risk).toBe('high');
			expect(c.label).toBe(label);
		});
	});

	describe('medium risk', () => {
		it.each([
			['net:https://api.openai.com', 'Network · outbound HTTPS'],
			['net:https://*.fuga.com', 'Network · outbound HTTPS'],
			['vault:read:anthropic', 'Read secret from vault'],
			['shell:dom:read', 'Read shell DOM (a11y tree)'],
			['shell:nav:write', 'Drive shell navigation'],
		])('classifies %s as med', (scope, label) => {
			const c = classifyScope(scope);
			expect(c.risk).toBe('med');
			expect(c.label).toBe(label);
		});
	});

	describe('low risk', () => {
		it.each([
			['net:127.0.0.1:*', 'Loopback only'],
			['supabase:read:transactions', 'Read from Supabase'],
			['fs:read:workspace', 'Read from disk'],
			['sidecar:actions', 'Bundled sidecar binary'],
		])('classifies %s as low', (scope, label) => {
			const c = classifyScope(scope);
			expect(c.risk).toBe('low');
			expect(c.label).toBe(label);
		});
	});

	it('falls back to Unclassified low for unknown scope shapes', () => {
		expect(classifyScope('something:we:dont:know')).toEqual({
			risk: 'low',
			label: 'Unclassified',
		});
		expect(classifyScope('')).toEqual({ risk: 'low', label: 'Unclassified' });
	});

	it('matches by prefix — declared globs do not bypass classification', () => {
		// A pkg author can't sneak a write past the high-risk band by extending
		// the path; the regex anchors at start, so the band is set by the
		// scope's leading namespace.
		expect(classifyScope('fs:write:.../weirdly/nested/path').risk).toBe('high');
		expect(classifyScope('shell.execute:any-binary-here').risk).toBe('high');
	});

	it('is case-sensitive — uppercase prefix does not match', () => {
		// The kernel emits scopes in canonical lowercase form. A capitalized
		// prefix means something is wrong upstream; we don't pretend it's the
		// same and silently classify — instead it falls to Unclassified so the
		// reviewer sees the anomaly.
		expect(classifyScope('FS:WRITE:foo').risk).toBe('low');
		expect(classifyScope('FS:WRITE:foo').label).toBe('Unclassified');
	});
});

describe('riskColor', () => {
	it('returns red for high', () => {
		expect(riskColor('high')).toBe('text-red-500');
	});
	it('returns amber for med', () => {
		expect(riskColor('med')).toBe('text-amber-500');
	});
	it('returns emerald for low', () => {
		expect(riskColor('low')).toBe('text-emerald-500');
	});
});
