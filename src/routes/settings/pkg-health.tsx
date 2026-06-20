// Settings → Packages → Health (install-integrity check + cleanup).
// Surfaces broken / orphaned pkg_installed records and offers one-click removal.
import { createFileRoute } from '@tanstack/react-router';
import { PkgHealthPanel } from '@/components/pkg/v2/pkg-health-panel';

export const Route = createFileRoute('/settings/pkg-health')({
	component: PkgHealthPanel,
});
