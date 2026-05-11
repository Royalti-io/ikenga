// Step 8 — Telemetry consent.
//
// APPROVAL.md locks: ship-default is OFF. The store seeds the payload
// with `DEFAULT_TELEMETRY_PAYLOAD = { enabled: false }` (Phase 3
// scaffolded the constant); the body just renders the toggle.

import { createFileRoute } from '@tanstack/react-router';

import { TelemetryBody } from '@/shell/onboarding/telemetry-body';
import { WizardStepper } from '@/shell/onboarding/wizard-stepper';

export const Route = createFileRoute('/onboarding/telemetry')({
	component: TelemetryStep,
});

function TelemetryStep() {
	return (
		<WizardStepper stepId="telemetry">
			{({ goNext }) => <TelemetryBody onContinue={goNext} />}
		</WizardStepper>
	);
}
