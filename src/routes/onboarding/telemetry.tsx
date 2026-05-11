// Phase 3 stub. Phase 4 wires the telemetry opt-in.
//
// APPROVAL.md locks: telemetry ship-default is OFF. The store exposes
// `DEFAULT_TELEMETRY_PAYLOAD` which Phase 4 should seed when the user
// first lands here.
import { createFileRoute } from '@tanstack/react-router';

import { DEFAULT_TELEMETRY_PAYLOAD } from '@/lib/shell/shell-store';
import { WizardStepper } from '@/shell/onboarding/wizard-stepper';

export const Route = createFileRoute('/onboarding/telemetry')({
	component: TelemetryStep,
});

function TelemetryStep() {
	return (
		<WizardStepper stepId="telemetry">
			{() => (
				<div className="mx-auto max-w-2xl">
					<h1 className="mb-4 text-3xl font-bold tracking-tight">Telemetry</h1>
					<p className="text-sm" style={{ color: 'var(--fg-muted)' }}>
						TODO step body — Phase 4 wires the opt-in toggle. Default payload is{' '}
						<code className="font-mono text-xs">{JSON.stringify(DEFAULT_TELEMETRY_PAYLOAD)}</code>{' '}
						(OFF, per APPROVAL.md).
					</p>
				</div>
			)}
		</WizardStepper>
	);
}
