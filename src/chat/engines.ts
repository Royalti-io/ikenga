/**
 * ADR-011 phase 4 — engine catalog for the composer's two-level
 * Engine → Model popover.
 *
 * Engines align with ADR-010 (engines are pkgs). The active engine
 * adapter is `AcpAdapter` (Claude Code via the user's `claude` CLI);
 * other engines are stubs surfaced as "not installed" so the user can
 * see the future surface and follow the "+ Install engine pkg" footer
 * link to the pkg manager.
 *
 * `installed: false` rows are non-functional — clicking them is a
 * no-op. Installing real OpenAI/Gemini engines will publish their
 * `kind: "engine"` manifests to the pkg registry and the catalog can
 * read installed-state from `pkgKernelStatus()` (deferred to a later
 * phase once any second-engine pkg actually exists).
 */
import type { ModelOption } from './adapter';

export interface EngineEntry {
	/** Stable id — used as a popover-row key and (for installed engines)
	 *  as a discriminator the composer can route on. */
	id: string;
	/** Display label rendered in the popover group header. */
	label: string;
	/** When false, the engine is rendered greyed with a "not installed"
	 *  tag; its model rows are non-clickable. The footer "Install engine
	 *  pkg" link routes the user to the pkg manager. */
	installed: boolean;
	/** Per-engine model list. For non-installed engines this is the
	 *  marketed shape we expect when the pkg ships. */
	models: ModelOption[];
	/** Optional one-line description shown under the engine header. */
	description?: string;
}

/** Canonical engine list. Order matters — installed engines render
 *  first; "not installed" engines below. */
export const ENGINE_CATALOG: EngineEntry[] = [
	{
		id: 'claude-code',
		label: 'Claude Code',
		installed: true,
		models: [
			{ id: 'claude-opus-4-7', label: 'Opus 4.7' },
			{ id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
			{ id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
		],
		description: 'Anthropic Claude via the local claude CLI.',
	},
	{
		id: 'openai',
		label: 'OpenAI',
		installed: false,
		models: [
			{ id: 'openai-gpt-4o', label: 'GPT-4o' },
			{ id: 'openai-gpt-4-1', label: 'GPT-4.1' },
			{ id: 'openai-o3', label: 'o3' },
		],
		description: 'GPT family via the OpenAI Responses API.',
	},
	{
		id: 'gemini',
		label: 'Gemini',
		installed: false,
		models: [
			{ id: 'gemini-2-5-pro', label: 'Gemini 2.5 Pro' },
			{ id: 'gemini-2-5-flash', label: 'Gemini 2.5 Flash' },
		],
		description: 'Google Gemini via the Generative Language API.',
	},
];

/** Find which engine owns a given model id. Returns null when the
 *  model is unknown (e.g. user typed a free-form id or installed an
 *  engine pkg the static catalog doesn't list yet). */
export function findEngineForModel(modelId: string | null | undefined): EngineEntry | null {
	if (!modelId) return null;
	for (const eng of ENGINE_CATALOG) {
		if (eng.models.some((m) => m.id === modelId)) return eng;
	}
	return null;
}

/** Look up a model's display label by id. Falls back to the raw id
 *  with `claude-` stripped + hyphens turned into spaces so unknown
 *  models still render sensibly in the pill. */
export function modelLabelFor(modelId: string | null | undefined): string {
	if (!modelId) return 'Auto';
	for (const eng of ENGINE_CATALOG) {
		const hit = eng.models.find((m) => m.id === modelId);
		if (hit) return hit.label;
	}
	return modelId.replace(/^claude-/, '').replace(/-/g, ' ');
}
