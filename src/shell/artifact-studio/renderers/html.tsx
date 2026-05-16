// HTML renderer — the only renderer landing in Phase 2. Thin wrapper
// around the existing `ViewerRouter` so loupe / compare get the same
// iframe stack (per-iframe CSP, iyke bridge, ikenga artifact bridge)
// every other artifact surface already uses.

import { ViewerRouter } from '@/viewer/auto-router';
import type { Renderer, RendererMountProps } from './types';

function HtmlRendererComponent({ path, paneId, source }: RendererMountProps) {
	return <ViewerRouter path={path} source={source ?? 'pane'} paneId={paneId} />;
}

export const htmlRenderer: Renderer = {
	kind: 'html',
	match(path, manifestKind) {
		if (manifestKind === 'html') return true;
		const lower = path.toLowerCase();
		return lower.endsWith('.html') || lower.endsWith('.htm');
	},
	Component: HtmlRendererComponent,
};
