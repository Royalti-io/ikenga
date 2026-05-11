// Phase 3 stub. Phase 4 wires the inline appearance picker (theme / mode /
// density mirrored from Settings → Appearance).
import { createFileRoute } from '@tanstack/react-router';

import { WizardStepper } from '@/shell/onboarding/wizard-stepper';

export const Route = createFileRoute('/onboarding/appearance')({
	component: AppearanceStep,
});

function AppearanceStep() {
	return (
		<WizardStepper stepId="appearance">
			{() => (
				<div className="mx-auto max-w-2xl">
					<h1 className="mb-4 text-3xl font-bold tracking-tight">Appearance</h1>
					<p className="text-sm" style={{ color: 'var(--fg-muted)' }}>
						TODO step body — Phase 4 wires theme / mode / density pickers, mirroring Settings →
						Appearance.
					</p>
				</div>
			)}
		</WizardStepper>
	);
}
