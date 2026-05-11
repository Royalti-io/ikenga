// Phase 5 — Onboarding pkg catalog.
//
// The list of pkgs the wizard shows the user during step 4. Each entry is a
// `ManifestLike` projection (so it threads through the connector resolver
// identically to an installed pkg's real manifest) plus presentational
// metadata for the picker card.
//
// This is intentionally a static list: the wizard runs before the user has
// configured any registry, and "browse the registry" is a post-onboarding
// flow that lives on `/install`. New pkgs added to the registry will appear
// on `/install` without needing to ship a shell update.

import type { ManifestLike } from './connectors';

export type CatalogIconKey =
	| 'studio'
	| 'tasks'
	| 'mail'
	| 'outbound'
	| 'content'
	| 'sales'
	| 'files'
	| 'engine';

export type CatalogTrafficLight = 'local-only' | 'needs-cloud' | 'engine';

export interface OnboardingPkgEntry {
	manifest: ManifestLike;
	display: string;
	summary: string;
	version: string;
	icon: CatalogIconKey;
	/** Coarse classification used by the filter bar above the pkg grid. */
	bucket: CatalogTrafficLight;
	/** Pre-selected by default on first run. */
	defaultSelected: boolean;
	/** Selection cannot be toggled off (e.g. the engine pkg the user
	 *  picked in step 2). */
	pinned?: boolean;
	/** Approximate download size, surfaced in the footer total. */
	sizeMb?: number;
}

// ──────────────────────────────────────────────────────────────────────
// Canonical entries
// ──────────────────────────────────────────────────────────────────────

export const ONBOARDING_PKG_CATALOG: readonly OnboardingPkgEntry[] = Object.freeze([
	{
		manifest: {
			id: 'com.ikenga.studio',
			name: 'Studio',
			version: '0.4.0',
			permissions: { 'vault.keys': [] },
		},
		display: 'Studio',
		summary: 'Storyboard, hyperframes, and Remotion-powered video for releases.',
		version: '0.4.0',
		icon: 'studio',
		bucket: 'local-only',
		defaultSelected: true,
		sizeMb: 14,
	},
	{
		manifest: {
			id: 'com.ikenga.tasks',
			name: 'Tasks',
			version: '0.3.1',
			capabilities: { supabase: { required: true } },
			permissions: { 'vault.keys': [] },
		},
		display: 'Tasks',
		summary: 'A kanban + agent inbox. Live-updates as your engine works.',
		version: '0.3.1',
		icon: 'tasks',
		bucket: 'needs-cloud',
		defaultSelected: true,
		sizeMb: 3.8,
	},
	{
		manifest: {
			id: 'com.ikenga.mail',
			name: 'Mail',
			version: '0.2.4',
			permissions: { 'vault.keys': ['RESEND_API_KEY'] },
		},
		display: 'Mail',
		summary: 'IMAP/JMAP triage with agent labels. Drafts go through your account.',
		version: '0.2.4',
		icon: 'mail',
		bucket: 'needs-cloud',
		defaultSelected: true,
		sizeMb: 6.1,
	},
	{
		manifest: {
			id: 'com.ikenga.outbound',
			name: 'Outbound',
			version: '0.1.6',
			permissions: { 'vault.keys': ['RESEND_API_KEY', 'LISTMONK_URL', 'LISTMONK_AUTH'] },
		},
		display: 'Outbound',
		summary: 'DSP pitch sequences and reach-out drips for label outreach.',
		version: '0.1.6',
		icon: 'outbound',
		bucket: 'needs-cloud',
		defaultSelected: false,
		sizeMb: 4.2,
	},
	{
		manifest: {
			id: 'com.ikenga.content',
			name: 'Content',
			version: '0.2.0',
			permissions: { 'vault.keys': [] },
		},
		display: 'Content',
		summary: 'Blog, changelog, help-doc pipelines that publish to Royalti CMS.',
		version: '0.2.0',
		icon: 'content',
		bucket: 'local-only',
		defaultSelected: true,
		sizeMb: 5.2,
	},
	{
		manifest: {
			id: 'com.ikenga.sales',
			name: 'Sales',
			version: '0.1.2',
			capabilities: { supabase: { required: true } },
			permissions: {
				'vault.keys': [
					'TWENTY_API_URL',
					'TWENTY_API_KEY',
					'STRIPE_SECRET_KEY',
					'STRIPE_WEBHOOK_SECRET',
				],
			},
		},
		display: 'Sales',
		summary: 'Pipeline tracker against Stripe + Twenty CRM with manual deal entry.',
		version: '0.1.2',
		icon: 'sales',
		bucket: 'needs-cloud',
		defaultSelected: false,
		sizeMb: 4.6,
	},
	{
		manifest: {
			id: 'com.ikenga.files',
			name: 'Files',
			version: '0.4.2',
			permissions: { 'vault.keys': [] },
		},
		display: 'Files',
		summary: 'File browser with agent-aware previews and quick actions.',
		version: '0.4.2',
		icon: 'files',
		bucket: 'local-only',
		defaultSelected: true,
		sizeMb: 2.4,
	},
	{
		manifest: {
			id: 'com.ikenga.engine-claude-code',
			name: 'Engine: Claude Code',
			version: '0.5.0',
			permissions: { 'vault.keys': [] },
		},
		display: 'Engine: Claude Code',
		summary: 'Default engine adapter. Updates independently of the shell.',
		version: '0.5.0',
		icon: 'engine',
		bucket: 'engine',
		defaultSelected: true,
		pinned: false,
		sizeMb: 8.0,
	},
]);

export const BUCKET_LABEL: Record<CatalogTrafficLight, string> = {
	'local-only': 'Local-only',
	'needs-cloud': 'Needs cloud',
	engine: 'Engine pkgs',
};

export function defaultSelectedIds(): string[] {
	return ONBOARDING_PKG_CATALOG.filter((p) => p.defaultSelected).map((p) => p.manifest.id);
}

export function findCatalogEntry(id: string): OnboardingPkgEntry | undefined {
	return ONBOARDING_PKG_CATALOG.find((p) => p.manifest.id === id);
}

export function countByBucket(): Record<CatalogTrafficLight | 'all', number> {
	const out: Record<CatalogTrafficLight | 'all', number> = {
		all: ONBOARDING_PKG_CATALOG.length,
		'local-only': 0,
		'needs-cloud': 0,
		engine: 0,
	};
	for (const entry of ONBOARDING_PKG_CATALOG) {
		out[entry.bucket]++;
	}
	return out;
}
