// Step 5 — Dynamic connector substeps.
//
// Phase 5: replaces the Phase 3 stub. The body reads the pkg selection
// from step 4, resolves which connectors are required, and renders one
// section per connector. When no connectors are required, it auto-skips
// (marks the step `skipped` and advances).
//
// Pkg install kicks off in the background on goNext — see Phase 6 wiring
// for `pkgKernelInstall(...)`.

import { createFileRoute } from '@tanstack/react-router';

import { ConnectorsBody } from '@/shell/onboarding/connectors-body';
import { WizardStepper } from '@/shell/onboarding/wizard-stepper';

export const Route = createFileRoute('/onboarding/connectors')({
	component: ConnectorsStep,
});

function ConnectorsStep() {
	return (
		<WizardStepper stepId="connectors">
			{({ goNext, skip }) => <ConnectorsBody onContinue={goNext} onSkip={skip} />}
		</WizardStepper>
	);
}
