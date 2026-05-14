// Read a manifest from an artifact HTML file on disk.
//
// The artifact format embeds its manifest as the body of a
// `<script type="application/json" id="ikenga-manifest">…</script>` tag in
// the document head. The host bridge parses this at runtime inside the
// iframe, but a few host-side flows (the Pin dialog, future Studio
// import) need the parsed manifest *before* the iframe mounts. This
// helper does the same regex + JSON.parse against the file contents
// fetched via `fsRead`, returning `null` for any failure path so callers
// can fall through to empty defaults.
//
// Pure string operations — no DOM, no Tauri-only APIs — so this is
// straightforward to unit-test under vitest's jsdom-free default.

import { fsRead } from '@/lib/tauri-cmd';

/** The shape we care about for the Pin dialog. A real artifact manifest
 *  (see contract/src/artifact/manifest.ts) has more fields; we surface
 *  only those that drive the dialog's defaults. */
export interface ArtifactManifestPreview {
	id?: string;
	name?: string;
	description?: string;
	icon?: { lucide?: string; emoji?: string };
	pin?: {
		suggested?: boolean;
		section?: string;
		icon?: string;
	};
}

const MANIFEST_RE =
	/<script\s+[^>]*?\bid\s*=\s*["']ikenga-manifest["'][^>]*?>([\s\S]*?)<\/script>/i;

/** Find the manifest's raw JSON text inside an HTML string. Exposed for
 *  testing and for reuse in flows that already have the HTML in hand. */
export function extractManifestJson(html: string): string | null {
	const match = MANIFEST_RE.exec(html);
	if (!match) return null;
	const body = match[1]?.trim();
	return body && body.length > 0 ? body : null;
}

/** Parse a manifest preview out of HTML text. Returns null when the
 *  script tag is missing, empty, or holds malformed JSON. */
export function parseManifestPreviewFromHtml(html: string): ArtifactManifestPreview | null {
	const json = extractManifestJson(html);
	if (!json) return null;
	try {
		const parsed = JSON.parse(json);
		if (!parsed || typeof parsed !== 'object') return null;
		// Trust the artifact author for the contents but only project the
		// fields we use. A future stricter validation can live in a separate
		// helper or use the Zod schema in @ikenga/contract once shipped.
		return parsed as ArtifactManifestPreview;
	} catch {
		return null;
	}
}

/** Read the artifact at `path` and parse its manifest preview. Returns
 *  null if the file isn't readable, isn't HTML-shaped (no `<script>` tag),
 *  or has malformed JSON. Never throws — the Pin dialog falls back to
 *  empty defaults when the manifest can't be parsed. */
export async function readManifestPreview(path: string): Promise<ArtifactManifestPreview | null> {
	let html: string;
	try {
		const result = await fsRead(path);
		// fsRead returns the file as a byte array (number[]). Decode as UTF-8
		// — the artifact format mandates UTF-8 and HTML defaults to it.
		html = new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(result.bytes));
	} catch {
		return null;
	}
	return parseManifestPreviewFromHtml(html);
}
