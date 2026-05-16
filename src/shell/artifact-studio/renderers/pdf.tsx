// PDF renderer — Studio surface for `*.pdf` artifacts.
//
// Wraps the existing ViewerRouter (which dispatches to the lazy
// `PdfView` renderer backed by react-pdf). Studio-specific pin
// coordinate mapping (page, x, y) lands when pin support generalizes
// beyond HTML element selectors — for now the renderer is a paged
// viewer with no pin overlay.

import { ViewerRouter } from '@/viewer/auto-router';
import type { Renderer, RendererMountProps } from './types';

function PdfRendererComponent({ path, paneId, source }: RendererMountProps) {
	return <ViewerRouter path={path} source={source ?? 'pane'} paneId={paneId} />;
}

export const pdfRenderer: Renderer = {
	kind: 'pdf',
	match(path, manifestKind) {
		if (manifestKind === 'pdf') return true;
		return path.toLowerCase().endsWith('.pdf');
	},
	Component: PdfRendererComponent,
};
