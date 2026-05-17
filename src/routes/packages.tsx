// Unified package surface — replaces the legacy /packages + /packages/browse
// + /install split. Outer chrome is mission-control tiles + filter pills +
// catalog; detail is the right-sliding loupe (Overview · Permissions · Trust
// · Settings · Manifest). Install is a sheet, not a route.
//
// `?filter=` deep-link param lets the Packages-mode sidebar focus a subset
// (e.g. ?filter=updates → only outdated pkgs). Default is 'all'.
//
// Design source: design/shell/concepts/04-pkgs/04-package-manager/v2-mission-control.html
// Plan:         plans/shell/2026-05-17-pkg-surface-unify.md

import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { PkgsSurface } from '@/components/pkg/v2/pkgs-surface';

const FILTER_VALUES = ['all', 'installed', 'updates', 'store', 'review', 'disabled'] as const;
const searchSchema = z.object({
	filter: z.enum(FILTER_VALUES).optional(),
});

function PackagesRoute() {
	const search = Route.useSearch();
	return <PkgsSurface initialFilter={search.filter ?? 'all'} />;
}

export const Route = createFileRoute('/packages')({
	component: PackagesRoute,
	validateSearch: searchSchema,
});
