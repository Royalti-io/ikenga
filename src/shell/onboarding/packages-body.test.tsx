// packages-body — selection drives the live connector preview.

import { describe, expect, it } from 'vitest';

import { ONBOARDING_PKG_CATALOG } from '@/lib/onboarding/pkg-catalog';

import { previewForSelection } from './packages-body';

describe('previewForSelection', () => {
	it('returns no connectors when the user picks nothing', () => {
		expect(previewForSelection([])).toEqual([]);
	});

	it('selecting only Studio yields zero connectors', () => {
		expect(previewForSelection(['com.ikenga.studio'])).toEqual([]);
	});

	it('selecting Tasks surfaces Supabase', () => {
		const out = previewForSelection(['com.ikenga.tasks']);
		expect(out).toHaveLength(1);
		expect(out[0]!.connectorId).toBe('supabase');
		expect(out[0]!.requiredBy).toEqual(['com.ikenga.tasks']);
	});

	it('selecting Outbound surfaces Resend + Listmonk', () => {
		const ids = previewForSelection(['com.ikenga.outbound']).map((r) => r.connectorId);
		expect(ids).toContain('resend');
		expect(ids).toContain('listmonk');
	});

	it('selecting Sales surfaces Supabase + Twenty + Stripe', () => {
		const ids = previewForSelection(['com.ikenga.sales']).map((r) => r.connectorId);
		expect(ids).toContain('supabase');
		expect(ids).toContain('twenty');
		expect(ids).toContain('stripe');
	});

	it('deselecting the last consumer removes the connector live', () => {
		const both = previewForSelection(['com.ikenga.tasks', 'com.ikenga.studio']);
		expect(both.some((r) => r.connectorId === 'supabase')).toBe(true);
		const onlyStudio = previewForSelection(['com.ikenga.studio']);
		expect(onlyStudio.some((r) => r.connectorId === 'supabase')).toBe(false);
	});

	it('groups consumers across multiple pkgs into a single requirement', () => {
		const out = previewForSelection(['com.ikenga.tasks', 'com.ikenga.sales']);
		const supabase = out.find((r) => r.connectorId === 'supabase');
		expect(supabase?.requiredBy).toEqual(['com.ikenga.sales', 'com.ikenga.tasks']);
	});
});

describe('ONBOARDING_PKG_CATALOG', () => {
	it('contains the 8 canonical pkgs from the prototype', () => {
		expect(ONBOARDING_PKG_CATALOG).toHaveLength(8);
	});

	it('every entry has a manifest id and a display name', () => {
		for (const entry of ONBOARDING_PKG_CATALOG) {
			expect(entry.manifest.id).toMatch(/^com\.ikenga\./);
			expect(entry.display.length).toBeGreaterThan(0);
		}
	});

	it('at least one entry declares capabilities.supabase.required', () => {
		const hasSupabase = ONBOARDING_PKG_CATALOG.some(
			(e) => e.manifest.capabilities?.supabase?.required === true
		);
		expect(hasSupabase).toBe(true);
	});

	it('at least one entry declares Resend in vault.keys', () => {
		const hasResend = ONBOARDING_PKG_CATALOG.some((e) =>
			(e.manifest.permissions?.['vault.keys'] ?? []).includes('RESEND_API_KEY')
		);
		expect(hasResend).toBe(true);
	});
});
