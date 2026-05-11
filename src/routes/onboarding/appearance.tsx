// Step 7 — Appearance (theme · mode · density).

import { createFileRoute } from '@tanstack/react-router';

import { AppearanceBody } from '@/shell/onboarding/appearance-body';
import { WizardStepper } from '@/shell/onboarding/wizard-stepper';

export const Route = createFileRoute('/onboarding/appearance')({
	component: AppearanceStep,
});

function AppearanceStep() {
	return (
		<WizardStepper stepId="appearance">
			{({ goNext }) => <AppearanceBody onContinue={goNext} />}
		</WizardStepper>
	);
}
