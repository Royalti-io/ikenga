import { describe, expect, it } from 'vitest';

import { CONNECTOR_REGISTRY, type ConnectorId, type ManifestLike } from './connectors';
import {
	formatRequirementMatrix,
	manifestTriggersConnector,
	resolveRequiredConnectors,
	withStatuses,
} from './resolve-connectors';

// ──────────────────────────────────────────────────────────────────────
// Fixtures — one synthetic manifest per v1 connector, plus a "local-only"
// pkg that triggers nothing. Real shell pkg manifests will declare these
// fields directly; the resolver is structural and doesn't care about ids.
// ──────────────────────────────────────────────────────────────────────

const tasksManifest: ManifestLike = {
	id: 'com.ikenga.tasks',
	capabilities: { supabase: { required: true } },
	permissions: { 'vault.keys': [] },
};

const studioManifest: ManifestLike = {
	id: 'com.ikenga.studio',
	// local-only — no caps, no vault keys.
	permissions: { 'vault.keys': [] },
};

const outboundManifest: ManifestLike = {
	id: 'com.ikenga.outbound',
	permissions: { 'vault.keys': ['RESEND_API_KEY', 'LISTMONK_URL', 'LISTMONK_AUTH'] },
};

const salesManifest: ManifestLike = {
	id: 'com.ikenga.sales',
	capabilities: { supabase: { required: true } },
	permissions: {
		'vault.keys': [
			'TWENTY_API_URL',
			'TWENTY_API_KEY',
			'STRIPE_SECRET_KEY',
			'STRIPE_WEBHOOK_SECRET',
		],
	},
};

const allManifests = [tasksManifest, studioManifest, outboundManifest, salesManifest];

function find(id: ConnectorId) {
	const c = CONNECTOR_REGISTRY.find((x) => x.id === id);
	if (!c) throw new Error(`registry missing ${id}`);
	return c;
}

// ──────────────────────────────────────────────────────────────────────
// resolveRequiredConnectors — per-connector trigger coverage
// ──────────────────────────────────────────────────────────────────────

describe('resolveRequiredConnectors', () => {
	it('empty selection yields no requirements', () => {
		expect(resolveRequiredConnectors([], allManifests)).toEqual([]);
	});

	it('selection of a local-only pkg yields no requirements', () => {
		const out = resolveRequiredConnectors(['com.ikenga.studio'], allManifests);
		expect(out).toEqual([]);
	});

	it('capabilities.supabase.required triggers the supabase connector', () => {
		const out = resolveRequiredConnectors(['com.ikenga.tasks'], allManifests);
		expect(out).toHaveLength(1);
		expect(out[0]!.connectorId).toBe('supabase');
		expect(out[0]!.requiredBy).toEqual(['com.ikenga.tasks']);
	});

	it('vault.keys superset triggers the resend connector', () => {
		const out = resolveRequiredConnectors(['com.ikenga.outbound'], allManifests);
		const resend = out.find((r) => r.connectorId === 'resend');
		expect(resend).toBeDefined();
		expect(resend?.requiredBy).toEqual(['com.ikenga.outbound']);
	});

	it('vault.keys superset triggers the listmonk connector (both keys required)', () => {
		const out = resolveRequiredConnectors(['com.ikenga.outbound'], allManifests);
		const listmonk = out.find((r) => r.connectorId === 'listmonk');
		expect(listmonk).toBeDefined();
		expect(listmonk?.requiredBy).toEqual(['com.ikenga.outbound']);
	});

	it('partial vault.keys subset does NOT trigger the listmonk connector', () => {
		const partial: ManifestLike = {
			id: 'com.ikenga.partial',
			permissions: { 'vault.keys': ['LISTMONK_URL'] }, // missing LISTMONK_AUTH
		};
		const out = resolveRequiredConnectors(['com.ikenga.partial'], [partial]);
		expect(out.find((r) => r.connectorId === 'listmonk')).toBeUndefined();
	});

	it('vault.keys superset triggers the twenty connector', () => {
		const out = resolveRequiredConnectors(['com.ikenga.sales'], allManifests);
		expect(out.find((r) => r.connectorId === 'twenty')).toBeDefined();
	});

	it('vault.keys superset triggers the stripe connector', () => {
		const out = resolveRequiredConnectors(['com.ikenga.sales'], allManifests);
		expect(out.find((r) => r.connectorId === 'stripe')).toBeDefined();
	});

	it('selecting every connector-requiring pkg surfaces all five connectors', () => {
		const out = resolveRequiredConnectors(
			['com.ikenga.tasks', 'com.ikenga.outbound', 'com.ikenga.sales'],
			allManifests
		);
		const ids = out.map((r) => r.connectorId).sort();
		expect(ids).toEqual(['listmonk', 'resend', 'stripe', 'supabase', 'twenty']);
	});

	it('groups consumers across multiple pkgs into a single requirement', () => {
		const tasksAndSales = resolveRequiredConnectors(
			['com.ikenga.tasks', 'com.ikenga.sales'],
			allManifests
		);
		const supabase = tasksAndSales.find((r) => r.connectorId === 'supabase');
		expect(supabase?.requiredBy).toEqual(['com.ikenga.sales', 'com.ikenga.tasks']);
	});

	it('deselecting the last consumer removes the connector', () => {
		const both = resolveRequiredConnectors(['com.ikenga.tasks'], allManifests);
		expect(both.some((r) => r.connectorId === 'supabase')).toBe(true);
		const none = resolveRequiredConnectors(['com.ikenga.studio'], allManifests);
		expect(none.some((r) => r.connectorId === 'supabase')).toBe(false);
	});

	it('capabilities.supabase.required === false does NOT trigger', () => {
		const soft: ManifestLike = {
			id: 'com.ikenga.soft',
			capabilities: { supabase: { required: false } },
		};
		const out = resolveRequiredConnectors(['com.ikenga.soft'], [soft]);
		expect(out).toEqual([]);
	});

	it('accepts a Set for selectedPkgIds', () => {
		const out = resolveRequiredConnectors(new Set(['com.ikenga.tasks']), allManifests);
		expect(out).toHaveLength(1);
		expect(out[0]!.connectorId).toBe('supabase');
	});

	it('output is stable: connectors ordered by registry order', () => {
		const out = resolveRequiredConnectors(
			['com.ikenga.tasks', 'com.ikenga.outbound', 'com.ikenga.sales'],
			allManifests
		);
		// Registry order is: supabase, resend, listmonk, twenty, stripe.
		expect(out.map((r) => r.connectorId)).toEqual([
			'supabase',
			'resend',
			'listmonk',
			'twenty',
			'stripe',
		]);
	});
});

// ──────────────────────────────────────────────────────────────────────
// manifestTriggersConnector — per-trigger-kind coverage
// ──────────────────────────────────────────────────────────────────────

describe('manifestTriggersConnector', () => {
	it('predicate trigger fires when predicate returns true', () => {
		const fake = {
			...find('supabase'),
			triggers: { predicate: () => true },
		};
		expect(manifestTriggersConnector(studioManifest, fake)).toBe(true);
	});

	it('predicate trigger does not fire when predicate returns false', () => {
		const fake = {
			...find('supabase'),
			triggers: { predicate: () => false },
		};
		expect(manifestTriggersConnector(studioManifest, fake)).toBe(false);
	});
});

// ──────────────────────────────────────────────────────────────────────
// withStatuses — status decoration is non-mutating
// ──────────────────────────────────────────────────────────────────────

describe('withStatuses', () => {
	it('decorates requirements without mutating the input', () => {
		const reqs = resolveRequiredConnectors(['com.ikenga.tasks'], allManifests);
		const before = JSON.stringify(reqs);
		const decorated = withStatuses(reqs, { supabase: 'configured' });
		expect(decorated[0]!.currentStatus).toBe('configured');
		expect(JSON.stringify(reqs)).toBe(before);
	});

	it('leaves currentStatus undefined for unstated connectors', () => {
		const reqs = resolveRequiredConnectors(
			['com.ikenga.tasks', 'com.ikenga.outbound'],
			allManifests
		);
		const decorated = withStatuses(reqs, { supabase: 'configured' });
		const resend = decorated.find((r) => r.connectorId === 'resend');
		expect(resend?.currentStatus).toBeUndefined();
	});
});

// ──────────────────────────────────────────────────────────────────────
// formatRequirementMatrix — debug helper used by the test report
// ──────────────────────────────────────────────────────────────────────

describe('formatRequirementMatrix', () => {
	it('returns a sentinel line for empty input', () => {
		expect(formatRequirementMatrix([])).toBe('(no connectors required)');
	});

	it('formats one line per connector with pkg consumers', () => {
		const reqs = resolveRequiredConnectors(
			['com.ikenga.tasks', 'com.ikenga.outbound', 'com.ikenga.sales'],
			allManifests
		);
		const matrix = formatRequirementMatrix(reqs);
		// Snapshot-style: each line should appear, in registry order.
		expect(matrix).toContain('supabase: com.ikenga.sales, com.ikenga.tasks');
		expect(matrix).toContain('resend: com.ikenga.outbound');
		expect(matrix).toContain('listmonk: com.ikenga.outbound');
		expect(matrix).toContain('twenty: com.ikenga.sales');
		expect(matrix).toContain('stripe: com.ikenga.sales');

		// Surface this in the test output so the phase report can paste it.
		console.log(`\n[connector-matrix]\n${matrix}`);
	});
});
