// Step 9 — Summary / finish.
//
// Renders one card per prior step with an Edit link. "Open workspace"
// stamps `completedAt` (via the chrome-supplied `goNext` which is
// wired to `finishOnboarding()` on the last step) and navigates to /.

import { createFileRoute } from '@tanstack/react-router';

import { SummaryBody } from '@/shell/onboarding/summary-body';
import { WizardStepper } from '@/shell/onboarding/wizard-stepper';

export const Route = createFileRoute('/onboarding/summary')({
	component: SummaryStep,
});

function SummaryStep() {
	return (
		<WizardStepper stepId="summary">
			{({ goNext, goTo }) => <SummaryBody onFinish={goNext} goTo={goTo} />}
		</WizardStepper>
	);
}
