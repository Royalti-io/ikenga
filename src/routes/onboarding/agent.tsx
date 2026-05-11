// Phase 3 stub. Step body is filled in by Phase 4 (agent picker) and
// Phase 7 (engine adapter loader hooks).
//
// APPROVAL.md locks: in offline-mode we skip the engine pkg auto-install
// — Phase 4's agent-picker reads that decision and exposes a "skip /
// offline" affordance.
import { createFileRoute } from '@tanstack/react-router';

import { WizardStepper } from '@/shell/onboarding/wizard-stepper';

export const Route = createFileRoute('/onboarding/agent')({
	component: AgentStep,
});

function AgentStep() {
	return (
		<WizardStepper stepId="agent">
			{() => (
				<div className="mx-auto max-w-2xl">
					<h1 className="mb-4 text-3xl font-bold tracking-tight">Coding agent</h1>
					<p className="text-sm" style={{ color: 'var(--fg-muted)' }}>
						TODO step body — Phase 4 wires the detected-agents picker (Claude Code default, Codex /
						Cursor secondary). Offline mode skips engine pkg auto-install per APPROVAL.md.
					</p>
				</div>
			)}
		</WizardStepper>
	);
}
