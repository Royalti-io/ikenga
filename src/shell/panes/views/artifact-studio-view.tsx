import { ArtifactStudio } from '@/shell/artifact-studio/studio-pane';

interface ArtifactStudioViewProps {
	path: string;
	paneId: string;
	density: 'grid' | 'loupe' | 'compare';
	vs?: string;
}

// Pane-registry shim. `kind: 'artifact-studio'` resolves here; the actual
// layout + chrome lives in shell/artifact-studio/.
export function ArtifactStudioView({ path, paneId, density, vs }: ArtifactStudioViewProps) {
	return <ArtifactStudio path={path} paneId={paneId} density={density} vs={vs} />;
}
