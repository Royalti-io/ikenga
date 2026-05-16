// Renderer interface — pluggable surface for the three Studio densities.
//
// One implementation per kind (html / pdf / slides / storyboard). The loupe
// + compare layouts use `pickRenderer(path, manifestKind?)` to mount the
// matching component; the grid density renders thumbnails directly via
// HTML iframe today and may grow to use this same Map later.
//
// v0 ships HTML only (Phase 2). pdf.js / slides / storyboard land in
// Phase 5 behind the same interface.

import type { ComponentType } from 'react';

export type Density = 'grid' | 'loupe' | 'compare';

export type RendererKind = 'html' | 'pdf' | 'slides' | 'storyboard';

export interface RendererMountProps {
	path: string;
	paneId: string;
	density: Density;
	/** Forwarded to the existing ViewerRouter `source` param for recents
	 *  tracking. Loupe / compare mount as `'pane'`; the grid density mounts
	 *  its own bare iframe so it doesn't need a value here. */
	source?: 'pane';
}

export interface Renderer {
	kind: RendererKind;
	/** True when this renderer handles the file at `path`. Callers
	 *  prefer manifest `kind` when present; otherwise file-extension
	 *  matching. Cheap — no I/O. */
	match(path: string, manifestKind?: string): boolean;
	Component: ComponentType<RendererMountProps>;
}
