// Unified package surface — replaces the legacy /packages + /packages/browse
// + /install split. Outer chrome is mission-control tiles + filter pills +
// catalog; detail is the right-sliding loupe (Overview · Permissions · Trust
// · Settings · Manifest). Install is a sheet, not a route.
//
// Design source: design/shell/concepts/04-pkgs/04-package-manager/v2-mission-control.html
// Plan:         plans/shell/2026-05-17-pkg-surface-unify.md

import { createFileRoute } from '@tanstack/react-router';
import { PkgsSurface } from '@/components/pkg/v2/pkgs-surface';

export const Route = createFileRoute('/packages')({
	component: PkgsSurface,
});
