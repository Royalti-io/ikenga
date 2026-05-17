// Legacy /install route → /packages with the install sheet pre-opened on
// the Local-path tab. The unified package surface (replaces /packages +
// /packages/browse + /install) owns install UX now; this redirect keeps
// older nav links and external deep-links pointing somewhere alive.
//
// Plan: plans/shell/2026-05-17-pkg-surface-unify.md — Phase 5.

import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/install')({
	beforeLoad: () => {
		throw redirect({ to: '/packages', search: { install: 'local-path' } });
	},
});
