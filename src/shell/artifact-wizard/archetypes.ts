// Archetype table for the artifact creation wizard (Phase C of
// plans/shell/2026-05-17-projects-and-artifact-wizard.md, decision D5).
//
// Each archetype is metadata + a starter scaffold; the actual visual
// content is the agent's job (D4 — wizard scaffolds, agent designs).
// `manifest.notes.kind` records the archetype slug so existing schemas
// keep working without a schema rev (R-6).
//
// Starter templates embed an `ikenga-manifest` script tag using the same
// `<script type="application/json" id="ikenga-manifest">` shape that
// `extractManifestJson` parses (see src/lib/artifact/manifest-from-file.ts).
// The template uses string interpolation for the manifest body so we don't
// duplicate the JSON shape in another file.

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
	folder: string;
	slug: string;
	skills: string[];
	userIntent: string;
}

export interface Archetype {
	slug: ArchetypeSlug;
	label: string;
	/** Lucide icon name. The wizard resolves these to React components via
	 *  the `icons` map from `lucide-react` so we keep this file dependency-
	 *  light (it has no React imports). */
	glyphName: string;
	description: string;
	defaultSubdir: string;
	defaultSkills: string[];
	kickoffPrompt: (ctx: KickoffCtx) => string;
	viewport: { w: number; h: number };
}

// ─── Starter template ────────────────────────────────────────────────────
//
// Shared HTML scaffold parameterised by archetype + name. Minimal — just
// enough to validate as an artifact (manifest tag present) and render a
// "scaffolded by Ikenga" placeholder before the agent fills it in.

interface StarterArgs {
	name: string;
	slug: string;
	archetype: ArchetypeSlug;
	viewport: { w: number; h: number };
	userIntent: string;
}

export function buildStarterTemplate(args: StarterArgs): string {
	const manifest = {
		id: args.slug,
		name: args.name,
		version: '0.1',
		viewport: { w: args.viewport.w, h: args.viewport.h },
		notes: {
			kind: args.archetype,
			...(args.userIntent.trim().length > 0 ? { userIntent: args.userIntent.trim() } : {}),
		},
	};
	const json = JSON.stringify(manifest, null, 2);
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<script type="application/json" id="ikenga-manifest">
${json}
	</script>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<title>${escapeHtml(args.name)}</title>
	<style>
		:root { color-scheme: light dark; }
		* { box-sizing: border-box; }
		html, body { margin: 0; padding: 0; }
		body {
			font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
			min-height: 100vh;
			display: flex;
			align-items: center;
			justify-content: center;
			background: Canvas;
			color: CanvasText;
		}
		.scaffold {
			max-width: 480px;
			padding: 32px;
			text-align: center;
			border: 1px dashed currentColor;
			border-radius: 12px;
			opacity: 0.8;
		}
		.scaffold h1 { margin: 0 0 8px; font-size: 18px; font-weight: 600; }
		.scaffold p { margin: 0; font-size: 13px; line-height: 1.5; opacity: 0.7; }
		.kind { font-family: ui-monospace, "JetBrains Mono", monospace; font-size: 11px; opacity: 0.6; }
	</style>
</head>
<body>
	<main class="scaffold">
		<div class="kind">archetype: ${args.archetype}</div>
		<h1>${escapeHtml(args.name)}</h1>
		<p>Scaffolded by Ikenga. The attached agent will replace this placeholder.</p>
	</main>
</body>
</html>
`;
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

// ─── Kickoff prompt template ─────────────────────────────────────────────
//
// Per the plan's example (one-pager), the kickoff prompt instructs the
// agent on the artifact path + project context + skills, then asks for a
// short clarifying volley before the build. `userIntent` is folded in only
// when present so blank-intent starts get a generic-enough prompt.

function defaultKickoff(archetypeLabel: string) {
	return (ctx: KickoffCtx): string => {
		const lines: string[] = [];
		const artifactPath = `${ctx.folder}/${ctx.slug}.html`;
		lines.push(`You're building a ${archetypeLabel} at \`${artifactPath}\`.`);
		lines.push('');
		lines.push('Context:');
		lines.push(`- Project: ${ctx.project.display_name} (${ctx.project.root_path ?? '<no root>'})`);
		lines.push(`- Archetype: ${archetypeLabel}`);
		if (ctx.skills.length > 0) {
			lines.push(`- Skills enabled: ${ctx.skills.join(', ')}`);
		}
		if (ctx.userIntent.trim().length > 0) {
			lines.push('');
			lines.push(`User intent: ${ctx.userIntent.trim()}`);
		}
		lines.push('');
		lines.push(
			'Start by asking 2-3 clarifying questions about audience, tone, and structure. ' +
				'Then propose a layout before writing the artifact. Use the ' +
				'`ikenga-artifact-builder` skill for the build phase.'
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
		defaultSkills: ['ikenga-artifact-builder', 'frontend-design'],
		kickoffPrompt: defaultKickoff('dashboard'),
		viewport: { w: 1440, h: 900 },
	},
	{
		slug: 'one-pager',
		label: 'One-pager',
		glyphName: 'FileText',
		description: 'A single hero + supporting sections. Pitches, summaries, decision docs.',
		defaultSubdir: 'one-pagers',
		defaultSkills: ['ikenga-artifact-builder', 'frontend-design'],
		kickoffPrompt: defaultKickoff('one-pager'),
		viewport: { w: 1440, h: 900 },
	},
	{
		slug: 'slides',
		label: 'Slides',
		glyphName: 'Presentation',
		description: 'Sequential slide deck with speaker notes. 16:9 viewport.',
		defaultSubdir: 'slides',
		defaultSkills: ['huashu-design', 'ikenga-artifact-builder'],
		kickoffPrompt: defaultKickoff('slide deck'),
		viewport: { w: 1920, h: 1080 },
	},
	{
		slug: 'social',
		label: 'Social',
		glyphName: 'Image',
		description: 'Square (1080×1080) social card. Single dense composition.',
		defaultSubdir: 'social',
		defaultSkills: ['huashu-design'],
		kickoffPrompt: defaultKickoff('social card'),
		viewport: { w: 1080, h: 1080 },
	},
	{
		slug: 'site',
		label: 'Site',
		glyphName: 'Globe',
		description: 'Multi-section landing-style site embedded in a single HTML file.',
		defaultSubdir: 'sites',
		defaultSkills: ['frontend-design', 'ikenga-artifact-builder'],
		kickoffPrompt: defaultKickoff('site'),
		viewport: { w: 1440, h: 900 },
	},
	{
		slug: 'scrollytelling',
		label: 'Scrollytelling',
		glyphName: 'ScrollText',
		description: 'Scroll-driven narrative with pinned sections and progressive reveals.',
		defaultSubdir: 'scrollytelling',
		defaultSkills: ['scrollytelling', 'frontend-design'],
		kickoffPrompt: defaultKickoff('scrollytelling experience'),
		viewport: { w: 1440, h: 900 },
	},
	{
		slug: 'blank',
		label: 'Blank',
		glyphName: 'Square',
		description: 'Empty artifact. The agent picks the structure from your intent.',
		defaultSubdir: 'artifacts',
		defaultSkills: ['ikenga-artifact-builder'],
		kickoffPrompt: defaultKickoff('artifact'),
		viewport: { w: 1440, h: 900 },
	},
];

export function findArchetype(slug: string | null | undefined): Archetype | null {
	if (!slug) return null;
	return ARCHETYPES.find((a) => a.slug === slug) ?? null;
}

/** Derive a filesystem slug from a display name. Lowercase, ASCII-only, with
 *  `-` separators. Empty input → `'untitled'`. Used by the wizard before
 *  collision-checking against existing files. */
export function slugifyName(name: string): string {
	const cleaned = name
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	return cleaned.length > 0 ? cleaned : 'untitled';
}
