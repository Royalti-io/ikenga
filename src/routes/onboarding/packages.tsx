// Phase 3 stub. Phase 4 wires the package picker.
import { createFileRoute } from '@tanstack/react-router';

import { WizardStepper } from '@/shell/onboarding/wizard-stepper';

export const Route = createFileRoute('/onboarding/packages')({
	component: PackagesStep,
});

function PackagesStep() {
	return (
		<WizardStepper stepId="packages">
			{() => (
				<div className="mx-auto max-w-2xl">
					<h1 className="mb-4 text-3xl font-bold tracking-tight">Packages</h1>
					<p className="text-sm" style={{ color: 'var(--fg-muted)' }}>
						TODO step body — Phase 4 wires the package picker (Studio, Tasks, Mail, Content, Files,
						Engine).
					</p>
				</div>
			)}
		</WizardStepper>
	);
}
