// Step 2 — Coding agent picker.
//
// APPROVAL.md locks: offline mode skips the engine pkg auto-install — the
// body's "Use offline mode" CTA sets `selectedAgentId: 'engine-noop'`
// and does NOT trigger any pkg install path.

import { createFileRoute } from '@tanstack/react-router';

import { AgentBody } from '@/shell/onboarding/agent-body';
import { WizardStepper } from '@/shell/onboarding/wizard-stepper';

export const Route = createFileRoute('/onboarding/agent')({
	component: AgentStep,
});

function AgentStep() {
	return (
		<WizardStepper stepId="agent">
			{({ goNext }) => <AgentBody onContinue={goNext} />}
		</WizardStepper>
	);
}
