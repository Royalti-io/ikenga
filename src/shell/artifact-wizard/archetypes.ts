// Archetype table for the artifact creation wizard.
//
// Each archetype is metadata used to brief the agent. Per the post-rewrite
// scope (2026-05-17): the wizard no longer scaffolds files. The agent
// decides where artifacts live (or asks the user). Each archetype still
// carries a `defaultSubdir` + slug suggestion that the kickoff prompt
// surfaces as a hint — the agent is free to ignore it.

export type ArchetypeSlug =
	| 'dashboard'
	| 'one-pager'
	| 'slides'
	| 'social'
	| 'site'
	| 'scrollytelling'
	| 'blank';

export interface KickoffCtx {
	project: { display_name: string; root_path: string | null };
	/** Suggested filename slug (derived from the wizard's Name field). The
	 *  agent uses this as a starting point; it can rename. */
	slug: string;
}

export interface Archetype {
	slug: ArchetypeSlug;
	label: string;
	/** Lucide icon name. Resolved at render time via `lucide-react`'s map so
	 *  this file stays React-free. */
	glyphName: string;
	description: string;
	/** Suggested default subdirectory under the project root, surfaced in
	 *  the kickoff prompt. Not enforced — the agent picks the final path. */
	defaultSubdir: string;
	kickoffPrompt: (ctx: KickoffCtx) => string;
	viewport: { w: number; h: number };
}

// ─── Kickoff prompt ──────────────────────────────────────────────────────

function defaultKickoff(archetypeLabel: string, defaultSubdir: string) {
	return (ctx: KickoffCtx): string => {
		const root = ctx.project.root_path ?? '<no root>';
		const suggestedPath = `${defaultSubdir}/${ctx.slug}.html`;
		const lines: string[] = [];
		lines.push(
			`Build a ${archetypeLabel} for project **${ctx.project.display_name}** (\`${root}\`).`
		);
		lines.push('');
		lines.push(
			`Suggested path: \`${suggestedPath}\` (under the project root). Use that, or ask me where it should live.`
		);
		lines.push('');
		lines.push(
			'Read `.claude/skills/` in this project to know which sub-skills are available, ' +
				'then ask 2-3 clarifying questions about audience, tone, and structure before ' +
				'writing anything. Use the `ikenga-artifact-builder` skill for the build phase.'
		);
		return lines.join('\n');
	};
}

// ─── Table ───────────────────────────────────────────────────────────────

export const ARCHETYPES: readonly Archetype[] = [
	{
		slug: 'dashboard',
		label: 'Dashboard',
		glyphName: 'LayoutDashboard',
		description: 'KPI grid, charts, tables. For status views and operational at-a-glance reads.',
		defaultSubdir: 'dashboards',
		kickoffPrompt: defaultKickoff('dashboard', 'dashboards'),
		viewport: { w: 1440, h: 900 },
	},
	{
		slug: 'one-pager',
		label: 'One-pager',
		glyphName: 'FileText',
		description: 'A single hero + supporting sections. Pitches, summaries, decision docs.',
		defaultSubdir: 'one-pagers',
		kickoffPrompt: defaultKickoff('one-pager', 'one-pagers'),
		viewport: { w: 1440, h: 900 },
	},
	{
		slug: 'slides',
		label: 'Slides',
		glyphName: 'Presentation',
		description: 'Sequential slide deck with speaker notes. 16:9 viewport.',
		defaultSubdir: 'slides',
		kickoffPrompt: defaultKickoff('slide deck', 'slides'),
		viewport: { w: 1920, h: 1080 },
	},
	{
		slug: 'social',
		label: 'Social',
		glyphName: 'Image',
		description: 'Square (1080×1080) social card. Single dense composition.',
		defaultSubdir: 'social',
		kickoffPrompt: defaultKickoff('social card', 'social'),
		viewport: { w: 1080, h: 1080 },
	},
	{
		slug: 'site',
		label: 'Site',
		glyphName: 'Globe',
		description: 'Multi-section landing-style site embedded in a single HTML file.',
		defaultSubdir: 'sites',
		kickoffPrompt: defaultKickoff('site', 'sites'),
		viewport: { w: 1440, h: 900 },
	},
	{
		slug: 'scrollytelling',
		label: 'Scrollytelling',
		glyphName: 'ScrollText',
		description: 'Scroll-driven narrative with pinned sections and progressive reveals.',
		defaultSubdir: 'scrollytelling',
		kickoffPrompt: defaultKickoff('scrollytelling experience', 'scrollytelling'),
		viewport: { w: 1440, h: 900 },
	},
	{
		slug: 'blank',
		label: 'Blank',
		glyphName: 'Square',
		description: 'Empty artifact. The agent picks the structure from your intent.',
		defaultSubdir: 'artifacts',
		kickoffPrompt: defaultKickoff('artifact', 'artifacts'),
		viewport: { w: 1440, h: 900 },
	},
];

export function findArchetype(slug: string | null | undefined): Archetype | null {
	if (!slug) return null;
	return ARCHETYPES.find((a) => a.slug === slug) ?? null;
}

/** Derive a filesystem slug from a display name. Lowercase, ASCII-only, with
 *  `-` separators. Empty input → `'untitled'`. Surfaced to the agent as a
 *  suggestion; the agent owns the final filename. */
export function slugifyName(name: string): string {
	const cleaned = name
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	return cleaned.length > 0 ? cleaned : 'untitled';
}
