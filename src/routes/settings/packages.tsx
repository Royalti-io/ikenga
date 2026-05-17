import { createFileRoute } from '@tanstack/react-router';

import { PkgsSurface } from '@/components/pkg/v2/pkgs-surface';

export const Route = createFileRoute('/settings/packages')({
	component: PkgsSurface,
});
