// Slides renderer — Studio surface for HTML-based decks.
//
// Today the deck format is `*.deck.html` — a self-contained HTML
// document with slide markup. The renderer hands the file off to the
// existing HtmlFrame (via ViewerRouter) which already runs full-page
// HTML inside a sandboxed iframe and handles the iyke bridge.
//
// `*.deck.json` (Reveal-driven JSON manifests) is reserved for a later
// follow-up — adding it needs a Reveal embed shim and the JSON-→-deck
// hydrator. v0 ignores it and falls through to the default renderer.

import { ViewerRouter } from '@/viewer/auto-router';
import type { Renderer, RendererMountProps } from './types';

function SlidesRendererComponent({ path, paneId, source }: RendererMountProps) {
	return <ViewerRouter path={path} source={source ?? 'pane'} paneId={paneId} />;
}

export const slidesRenderer: Renderer = {
	kind: 'slides',
	match(path, manifestKind) {
		if (manifestKind === 'slides') return true;
		const lower = path.toLowerCase();
		return lower.endsWith('.deck.html');
	},
	Component: SlidesRendererComponent,
};
