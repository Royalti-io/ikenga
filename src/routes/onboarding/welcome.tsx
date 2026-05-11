// Step 1 — Welcome / system preflight.
//
// Body lives in `src/shell/onboarding/welcome-body.tsx`; this route just
// wires the body into the wizard chrome.

import { createFileRoute } from '@tanstack/react-router';

import { WelcomeBody } from '@/shell/onboarding/welcome-body';
import { WizardStepper } from '@/shell/onboarding/wizard-stepper';

export const Route = createFileRoute('/onboarding/welcome')({
	component: WelcomeStep,
});

function WelcomeStep() {
	return (
		<WizardStepper stepId="welcome">
			{({ goNext }) => <WelcomeBody onContinue={goNext} />}
		</WizardStepper>
	);
}
