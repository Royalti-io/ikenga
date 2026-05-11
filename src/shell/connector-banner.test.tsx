import { describe, expect, it } from 'vitest';

import { _previewToManifest } from '@/lib/onboarding/use-installed-manifests';

import { describeMissing } from './connector-banner';

describe('describeMissing', () => {
	it('returns the empty string when no connectors are missing', () => {
		expect(describeMissing([])).toBe('');
	});

	it('names the connector when exactly one is missing', () => {
		expect(describeMissing(['supabase'])).toContain('Supabase');
		expect(describeMissing(['resend'])).toContain('Resend');
	});

	it('uses a count when multiple connectors are missing', () => {
		const out = describeMissing(['supabase', 'resend', 'listmonk']);
		expect(out).toContain('3 connectors');
	});
});

describe('previewToManifest', () => {
	it('passes through the supabase capability', () => {
		const m = _previewToManifest('com.x.y', {
			capabilities: { supabase: { required: true } },
			permissions: {},
		});
		expect(m.capabilities?.supabase?.required).toBe(true);
	});

	it('handles missing capabilities + permissions defensively', () => {
		const m = _previewToManifest('com.x.y', {});
		expect(m.id).toBe('com.x.y');
		expect(m.capabilities).toBeNull();
		expect(m.permissions?.['vault.keys']).toEqual([]);
	});

	it('preserves vault.keys when present', () => {
		const m = _previewToManifest('com.x.y', {
			permissions: { 'vault.keys': ['RESEND_API_KEY'] },
		});
		expect(m.permissions?.['vault.keys']).toEqual(['RESEND_API_KEY']);
	});

	it('ignores a non-array vault.keys value', () => {
		const m = _previewToManifest('com.x.y', {
			permissions: { 'vault.keys': 'not-an-array' as unknown as string[] },
		});
		expect(m.permissions?.['vault.keys']).toEqual([]);
	});
});
