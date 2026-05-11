// Phase 3 stub. Phase 6 owns the .claude/ scaffolder (Merge / Skip /
// Overwrite-with-backup, per APPROVAL.md).
import { createFileRoute } from '@tanstack/react-router';

import { WizardStepper } from '@/shell/onboarding/wizard-stepper';

export const Route = createFileRoute('/onboarding/scaffolding')({
	component: ScaffoldingStep,
});

function ScaffoldingStep() {
	return (
		<WizardStepper stepId="scaffolding">
			{() => (
				<div className="mx-auto max-w-2xl">
					<h1 className="mb-4 text-3xl font-bold tracking-tight">Scaffolding</h1>
					<p className="text-sm" style={{ color: 'var(--fg-muted)' }}>
						TODO step body — Phase 6 wires the .claude/ scaffolder with Merge / Skip /
						Overwrite-with-backup modes.
					</p>
				</div>
			)}
		</WizardStepper>
	);
}
