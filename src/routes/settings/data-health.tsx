// Settings → Data health (domain soft-FK orphan audit).
// Surfaces dangling cross-domain references in the Atelier/PA tables (read-only).
import { createFileRoute } from '@tanstack/react-router';
import { DataHealthPanel } from '@/components/pkg/v2/data-health-panel';

export const Route = createFileRoute('/settings/data-health')({
	component: DataHealthPanel,
});
