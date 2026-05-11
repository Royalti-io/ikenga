// Phase 3 stub. Step body is filled in by Phase 4.
import { createFileRoute } from '@tanstack/react-router';

import { WizardStepper } from '@/shell/onboarding/wizard-stepper';

export const Route = createFileRoute('/onboarding/welcome')({
	component: WelcomeStep,
});

function WelcomeStep() {
	return (
		<WizardStepper stepId="welcome">
			{() => (
				<div className="mx-auto max-w-2xl">
					<p
						className="mb-3 text-xs font-semibold uppercase tracking-[0.04em]"
						style={{ color: 'var(--primary)' }}
					>
						First-run setup
					</p>
					<h1 className="mb-4 text-4xl font-bold leading-tight tracking-tight">Welcome step</h1>
					<p className="text-sm" style={{ color: 'var(--fg-muted)' }}>
						TODO step body — Phase 4 fills in welcome + preflight content.
					</p>
				</div>
			)}
		</WizardStepper>
	);
}
