// Renderer registry. Module-level Map; Phase 5 will add three more impls
// (pdf / slides / storyboard) each registering at boot via the same
// `register` hook. v0 just has HTML.

import { htmlRenderer } from './html';
import type { Renderer, RendererKind } from './types';

const REGISTRY = new Map<RendererKind, Renderer>([['html', htmlRenderer]]);

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
