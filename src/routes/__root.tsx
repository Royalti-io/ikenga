import { useEffect } from 'react';
import { Outlet, createRootRoute, useLocation, useNavigate } from '@tanstack/react-router';

import { Workspace } from '@/shell/workspace';
import { usePaneScope } from '@/shell/panes/views/route-view';
import { useShellStore } from '@/lib/shell/shell-store';

function RootRoute() {
	// When this same root component renders inside a pane's memory router,
	// `usePaneScope` returns the pane id. We must only emit <Outlet /> in
	// that case — rendering Workspace again would recursively mount the
	// entire shell inside every route pane.
	const paneScope = usePaneScope();
	const location = useLocation();
	const navigate = useNavigate();
	const onboardingMode = useShellStore((s) => s.onboarding.mode);
	const onboardingCompletedAt = useShellStore((s) => s.onboarding.completedAt);

	// Phase 3 boot redirect — first-run users whose wizard hasn't completed
	// get bounced to `/onboarding`. We only do this in the top-level shell
	// (paneScope === null) because individual panes are workspace-internal
	// and shouldn't reroute the whole window.
	useEffect(() => {
		if (paneScope !== null) return;
		if (location.pathname.startsWith('/onboarding')) return;
		if (onboardingMode === 'first_run' && onboardingCompletedAt === null) {
			void navigate({ to: '/onboarding' });
		}
	}, [paneScope, location.pathname, navigate, onboardingMode, onboardingCompletedAt]);

	if (paneScope !== null) {
		return <Outlet />;
	}

	// Onboarding renders edge-to-edge — bypass the Workspace chrome.
	if (location.pathname.startsWith('/onboarding')) {
		return (
			<div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
				<Outlet />
			</div>
		);
	}

	return <Workspace />;
}

export const Route = createRootRoute({
	component: RootRoute,
});
