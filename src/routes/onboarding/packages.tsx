// Step 4 — App packages picker.
//
// Phase 5: replaces the Phase 3 stub. Selection persists into the
// wizard payload so the Connectors step (5) can derive its substeps via
// the resolver in `@/lib/onboarding/resolve-connectors`.
import { createFileRoute } from '@tanstack/react-router';

import { PackagesBody } from '@/shell/onboarding/packages-body';
import { WizardStepper } from '@/shell/onboarding/wizard-stepper';

export const Route = createFileRoute('/onboarding/packages')({
	component: PackagesStep,
});

function PackagesStep() {
	return (
		<WizardStepper stepId="packages">
			{({ goNext }) => <PackagesBody onContinue={goNext} />}
		</WizardStepper>
	);
}
