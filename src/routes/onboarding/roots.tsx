// Phase 3 stub. Phase 4 wires the project-roots picker.
import { createFileRoute } from '@tanstack/react-router';

import { WizardStepper } from '@/shell/onboarding/wizard-stepper';

export const Route = createFileRoute('/onboarding/roots')({
	component: RootsStep,
});

function RootsStep() {
	return (
		<WizardStepper stepId="roots">
			{() => (
				<div className="mx-auto max-w-2xl">
					<h1 className="mb-4 text-3xl font-bold tracking-tight">Project roots</h1>
					<p className="text-sm" style={{ color: 'var(--fg-muted)' }}>
						TODO step body — Phase 4 wires the project-roots picker (writes into
						`useShellStore.fileRoots` + `claudeProjectRoots`).
					</p>
				</div>
			)}
		</WizardStepper>
	);
}
