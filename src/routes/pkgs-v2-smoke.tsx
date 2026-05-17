// Smoke route for the v2 unified pkg surface.
// Mounts <PkgsSurface /> in isolation so the new chrome can be verified
// against real kernel data without touching the production /packages route.

import { createFileRoute } from '@tanstack/react-router';
import { PkgsSurface } from '@/components/pkg/v2/pkgs-surface';

export const Route = createFileRoute('/pkgs-v2-smoke')({
	component: PkgsSurface,
});
