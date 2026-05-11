// Phase 3 stub. Phase 5 owns the dynamic connector substep machinery
// (Supabase / Resend / Listmonk surface based on selected packages).
import { createFileRoute } from '@tanstack/react-router';

import { WizardStepper } from '@/shell/onboarding/wizard-stepper';

export const Route = createFileRoute('/onboarding/connectors')({
	component: ConnectorsStep,
});

function ConnectorsStep() {
	return (
		<WizardStepper stepId="connectors">
			{() => (
				<div className="mx-auto max-w-2xl">
					<h1 className="mb-4 text-3xl font-bold tracking-tight">Connectors</h1>
					<p className="text-sm" style={{ color: 'var(--fg-muted)' }}>
						TODO step body — Phase 5 wires the dynamic connector substeps (Supabase / Resend /
						Listmonk) derived from the packages picker.
					</p>
				</div>
			)}
		</WizardStepper>
	);
}
