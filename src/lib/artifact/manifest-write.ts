// Counterpart to manifest-from-file.ts — writes a manifest back into an
// artifact HTML document.
//
// The single-file artifact format embeds its manifest as the body of a
// `<script type="application/json" id="ikenga-manifest">…</script>` tag in
// the document head. The Studio's manifest editor mutates a parsed manifest
// in memory; this helper splices the serialised JSON back into the source.
//
// Pure string operations — no DOM, easy to test under vitest without jsdom.
//
// Design notes:
//
// - If the script tag exists, only its body is replaced. Attributes,
//   surrounding whitespace, and the rest of the document round-trip
//   unchanged. The pretty-printed JSON (`JSON.stringify(_, null, 2)`)
//   matches what the skill template emits, so diff churn stays minimal.
// - If the script tag is missing, one is inserted into `<head>` (or, as a
//   last-resort fallback for malformed documents without a head, before
//   the closing `</html>` or appended at the end).
// - The manifest schema is `unknown` here on purpose: this module is also
//   reachable from the manifest editor with a partially-valid (in-flight)
//   shape, and `safeParse` validation happens in the caller.

import type { ArtifactManifest } from '@ikenga/contract/artifact';

const MANIFEST_TAG_RE =
	/(<script\s+[^>]*?\bid\s*=\s*["']ikenga-manifest["'][^>]*?>)([\s\S]*?)(<\/script>)/i;

const HEAD_OPEN_RE = /<head(?:\s[^>]*)?>/i;
const HTML_CLOSE_RE = /<\/html\s*>/i;

const NEW_TAG_TEMPLATE = (json: string) =>
	`\n\t<script type="application/json" id="ikenga-manifest">\n${json}\n\t</script>`;

/** Replace (or insert) the `<script id="ikenga-manifest">` body in `html`
 *  with the JSON-serialised `manifest`. The returned string is the new
 *  document; the original is not mutated. */
export function writeManifestIntoHtml(html: string, manifest: ArtifactManifest | unknown): string {
	const json = JSON.stringify(manifest, null, 2);

	if (MANIFEST_TAG_RE.test(html)) {
		return html.replace(
			MANIFEST_TAG_RE,
			(_match, open, _body, close) => `${open}\n${json}\n${close}`
		);
	}

	const newTag = NEW_TAG_TEMPLATE(json);

	// Insert immediately after <head …>. Most artifact docs have a head.
	if (HEAD_OPEN_RE.test(html)) {
		return html.replace(HEAD_OPEN_RE, (match) => `${match}${newTag}`);
	}

	// Documents without a head — slip it in just before </html> if present,
	// or append. Both are rare-edge fallbacks; the skill template always
	// produces a head.
	if (HTML_CLOSE_RE.test(html)) {
		return html.replace(HTML_CLOSE_RE, (match) => `${newTag}\n${match}`);
	}
	return `${html}${newTag}`;
}
