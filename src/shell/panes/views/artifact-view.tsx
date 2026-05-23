import { ViewerRouter } from '@/viewer/auto-router';

interface ArtifactViewProps {
	path: string;
	/** Forwarded to HtmlFrame for iyke iframe bridging. */
	paneId?: string;
}

// Thin pane-registry shim. Routing + chrome live in src/viewer/auto-router —
// this module exists so the pane store's `kind: 'artifact'` view continues to
// resolve to a stable export.
export function ArtifactView({ path, paneId }: ArtifactViewProps) {
	return <ViewerRouter path={path} source="pane" paneId={paneId} editable />;
}
