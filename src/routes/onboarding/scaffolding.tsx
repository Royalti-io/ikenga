// Step 6 — .claude/ scaffolding UI shell.
//
// Phase 4 owns the UI. Phase 6 implements the `scaffold_agent_config`
// Tauri command body (currently returns `Err("not_implemented")`).
//
// APPROVAL.md locks: Merge / Skip / Overwrite-with-backup modes; never
// silently destroy an existing .claude/ — the dialog always defaults to
// Merge when the dir is present.

import { createFileRoute } from '@tanstack/react-router';

import { ScaffoldingBody } from '@/shell/onboarding/scaffolding-body';
import { WizardStepper } from '@/shell/onboarding/wizard-stepper';

export const Route = createFileRoute('/onboarding/scaffolding')({
	component: ScaffoldingStep,
});

function ScaffoldingStep() {
	return (
		<WizardStepper stepId="scaffolding">
			{({ goNext, skip }) => <ScaffoldingBody onContinue={goNext} onSkip={skip} />}
		</WizardStepper>
	);
}
