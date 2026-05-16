import { ArtifactGridPane } from '@/shell/artifact-grid/grid-pane';

interface ArtifactGridViewProps {
	path: string;
	paneId: string;
}

// Pane-registry shim. The full grid implementation lives in
// `src/shell/artifact-grid/`; this file exists so the pane store's
// `kind: 'artifact-grid'` view resolves to a stable export.
export function ArtifactGridView({ path, paneId }: ArtifactGridViewProps) {
	return <ArtifactGridPane path={path} paneId={paneId} />;
}
