// Renderer registry. Module-level Map; each impl registers at module
// load via its entry below. New renderers add a Map entry here and
// nothing else — the loupe / compare layouts pick by `match()` order.

import { htmlRenderer } from './html';
import { pdfRenderer } from './pdf';
import { slidesRenderer } from './slides';
import { storyboardRenderer } from './storyboard';
import type { Renderer, RendererKind } from './types';

const REGISTRY = new Map<RendererKind, Renderer>([
	// Order matters when manifest kind is unset — first matching pattern
	// wins. Storyboard / slides extensions are more specific than `.html`,
	// so they precede the HTML fallback.
	['storyboard', storyboardRenderer],
	['slides', slidesRenderer],
	['pdf', pdfRenderer],
	['html', htmlRenderer],
]);

export function pickRenderer(path: string, manifestKind?: string): Renderer {
	// Prefer manifest kind when set; fall back to extension match.
	if (manifestKind) {
		const byKind = REGISTRY.get(manifestKind as RendererKind);
		if (byKind && byKind.match(path, manifestKind)) return byKind;
	}
	for (const r of REGISTRY.values()) {
		if (r.match(path, manifestKind)) return r;
	}
	// HTML is the historical default — the prior viewer's auto-router
	// also lands here for unknown extensions, since the iframe can host
	// almost anything via the host-served URL.
	return htmlRenderer;
}

export function registerRenderer(r: Renderer): void {
	REGISTRY.set(r.kind, r);
}

export type { Renderer, RendererKind, Density, RendererMountProps } from './types';
