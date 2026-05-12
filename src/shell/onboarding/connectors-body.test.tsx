// connectors-body — pure helper coverage.

import { describe, expect, it } from 'vitest';

import type { ConnectorId, ConnectorStatus } from '@/lib/onboarding/connectors';
import type { ConnectorRequirement } from '@/lib/onboarding/resolve-connectors';

import { isAutoSkippable, isReadyToContinue, summariseRequirements } from './connectors-body';

// ──────────────────────────────────────────────────────────────────────
// isAutoSkippable — empty/local-only selections collapse the step
// ──────────────────────────────────────────────────────────────────────

describe('isAutoSkippable', () => {
	it('returns true when no pkgs are selected', () => {
		expect(isAutoSkippable([])).toBe(true);
	});

	it('returns true when only local-only pkgs are selected', () => {
		expect(isAutoSkippable(['com.ikenga.studio', 'com.ikenga.files'])).toBe(true);
	});

	it('returns false when a connector-requiring pkg is selected', () => {
		expect(isAutoSkippable(['com.ikenga.tasks'])).toBe(false);
	});

	it('returns false when only a vault-keys-driven pkg is selected', () => {
		expect(isAutoSkippable(['com.ikenga.mail'])).toBe(false);
	});
});

// ──────────────────────────────────────────────────────────────────────
// isReadyToContinue — guards the wizard's Continue button
// ──────────────────────────────────────────────────────────────────────

function mockRequirement(id: ConnectorId): ConnectorRequirement {
	return { connectorId: id, requiredBy: ['com.example.test'] };
}

describe('isReadyToContinue', () => {
	const reqs: ConnectorRequirement[] = [mockRequirement('supabase'), mockRequirement('resend')];

	it('is true when there are no requirements at all', () => {
		expect(isReadyToContinue([], new Set(), new Set(), {})).toBe(true);
	});

	it('is false when at least one requirement is still pending', () => {
		expect(isReadyToContinue(reqs, new Set(['supabase']), new Set(), {})).toBe(false);
	});

	it('is true when every connector is either configured or skipped', () => {
		expect(isReadyToContinue(reqs, new Set(['supabase']), new Set(['resend']), {})).toBe(true);
	});

	it('accepts live status of `configured` as configured', () => {
		const live: Partial<Record<ConnectorId, ConnectorStatus>> = {
			supabase: 'configured',
			resend: 'configured',
		};
		expect(isReadyToContinue(reqs, new Set(), new Set(), live)).toBe(true);
	});

	it('does not treat `partial` or `not_configured` live status as ready', () => {
		const live: Partial<Record<ConnectorId, ConnectorStatus>> = {
			supabase: 'partial',
			resend: 'not_configured',
		};
		expect(isReadyToContinue(reqs, new Set(), new Set(), live)).toBe(false);
	});
});

// ──────────────────────────────────────────────────────────────────────
// summariseRequirements — sticky footer copy
// ──────────────────────────────────────────────────────────────────────

describe('summariseRequirements', () => {
	const reqs: ConnectorRequirement[] = [
		mockRequirement('supabase'),
		mockRequirement('resend'),
		mockRequirement('listmonk'),
	];

	it('counts pending when nothing is done', () => {
		expect(summariseRequirements(reqs, new Set(), new Set(), {})).toBe(
			'0/3 configured · 3 pending'
		);
	});

	it('counts skipped explicitly', () => {
		expect(summariseRequirements(reqs, new Set(['supabase']), new Set(['resend']), {})).toBe(
			'1/3 configured · 1 skipped · 1 pending'
		);
	});

	it('omits skipped + pending when all are done', () => {
		expect(
			summariseRequirements(reqs, new Set(['supabase', 'resend', 'listmonk']), new Set(), {})
		).toBe('3/3 configured');
	});

	it('treats live `configured` status as done even without explicit ack', () => {
		const live: Partial<Record<ConnectorId, ConnectorStatus>> = {
			supabase: 'configured',
		};
		expect(summariseRequirements(reqs, new Set(), new Set(), live)).toBe(
			'1/3 configured · 2 pending'
		);
	});
});
