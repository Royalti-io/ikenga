// Phase 3 stub. Phase 4 wires the summary grid + "Open workspace" exit.
import { createFileRoute } from '@tanstack/react-router';

import { WizardStepper } from '@/shell/onboarding/wizard-stepper';

export const Route = createFileRoute('/onboarding/summary')({
	component: SummaryStep,
});

function SummaryStep() {
	return (
		<WizardStepper stepId="summary">
			{() => (
				<div className="mx-auto max-w-3xl">
					<p
						className="mb-2 text-xs font-semibold uppercase tracking-[0.04em]"
						style={{ color: 'var(--primary)' }}
					>
						All set
					</p>
					<h1 className="mb-4 text-4xl font-bold tracking-tight">Summary</h1>
					<p className="text-sm" style={{ color: 'var(--fg-muted)' }}>
						TODO step body — Phase 4 renders the summary grid with per-step "Edit" links that
						re-open prior steps inside the wizard (APPROVAL.md). The final "Open workspace" button
						calls `finishOnboarding()` and navigates back to the workspace.
					</p>
				</div>
			)}
		</WizardStepper>
	);
}
