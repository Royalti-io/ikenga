// Step 3 — Project & file roots.

import { createFileRoute } from '@tanstack/react-router';

import { RootsBody } from '@/shell/onboarding/roots-body';
import { WizardStepper } from '@/shell/onboarding/wizard-stepper';

export const Route = createFileRoute('/onboarding/roots')({
	component: RootsStep,
});

function RootsStep() {
	return (
		<WizardStepper stepId="roots">
			{({ goNext }) => <RootsBody onContinue={goNext} />}
		</WizardStepper>
	);
}
