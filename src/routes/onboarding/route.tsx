// Onboarding wizard layout route.
//
// All step routes live under this — `/onboarding/welcome`, `/onboarding/agent`,
// etc. Variant A (the approved Phase 1 chrome) is edge-to-edge full window,
// which means we don't render the workspace activity bar / sidebar / dock
// at all when we're inside the wizard.
//
// We rely on TanStack's parent layout `Outlet` here. The workspace shell
// itself can detect the `/onboarding` prefix on its own (see boot-redirect
// in `__root.tsx`); this route only handles the in-wizard rendering.

import { Outlet, createFileRoute, redirect } from '@tanstack/react-router';

import { useShellStore, ONBOARDING_STEPS } from '@/lib/shell/shell-store';

export const Route = createFileRoute('/onboarding')({
	beforeLoad: ({ location }) => {
		// `/onboarding` (no step) → route to the current active step.
		if (location.pathname === '/onboarding' || location.pathname === '/onboarding/') {
			const state = useShellStore.getState();
			const idx = Math.min(Math.max(0, state.onboarding.activeIndex), ONBOARDING_STEPS.length - 1);
			const activeId = ONBOARDING_STEPS[idx]!;
			throw redirect({ to: `/onboarding/${activeId}` });
		}
	},
	component: OnboardingLayout,
});

function OnboardingLayout() {
	// Edge-to-edge: just an Outlet. The step bodies wrap themselves in
	// <WizardStepper> which provides the chrome.
	return <Outlet />;
}
