// shell-store onboarding migration tests.
//
// The migrate fn is hoisted out of the persist middleware into a named
// export (`migrateShellStore`) so we can call it directly here without
// touching zustand's internal API surface.

import { describe, expect, it } from 'vitest';

import {
	ONBOARDING_STEPS,
	ONBOARDING_STATE_VERSION,
	type OnboardingState,
	createDefaultOnboardingState,
	migrateShellStore,
} from './shell-store';

describe('shell-store onboarding migration', () => {
	it('seeds a fresh OnboardingState when missing from persisted blob', () => {
		const migrated = migrateShellStore(
			{
				activeMode: 'app',
				fileRoots: ['~/royalti-co'],
				claudeProjectRoots: ['~/royalti-co'],
				claudeWatchEnabled: true,
			},
			7
		) as { onboarding: OnboardingState };

		expect(migrated.onboarding).toBeDefined();
		expect(migrated.onboarding.version).toBe(ONBOARDING_STATE_VERSION);
		expect(migrated.onboarding.completedAt).toBeNull();
		expect(migrated.onboarding.mode).toBe('first_run');
		for (const id of ONBOARDING_STEPS) {
			expect(migrated.onboarding.steps[id].status).toBe('pending');
		}
	});

	it('migrates legacy `agent_onboarded` + `selected_agent_id` into the agent step', () => {
		const migrated = migrateShellStore(
			{
				activeMode: 'app',
				agent_onboarded: true,
				selected_agent_id: 'claude-code',
			},
			7
		) as {
			onboarding: OnboardingState;
			agent_onboarded?: boolean;
			selected_agent_id?: string | null;
		};

		expect(migrated.onboarding.selectedAgentId).toBe('claude-code');
		expect(migrated.onboarding.steps.agent.status).toBe('completed');
		expect(typeof migrated.onboarding.steps.agent.completedAt).toBe('number');
		expect(migrated.onboarding.steps.agent.payload).toEqual({ agentId: 'claude-code' });

		// Legacy keys are scrubbed so they don't get reused.
		expect(migrated.agent_onboarded).toBeUndefined();
		expect(migrated.selected_agent_id).toBeUndefined();

		// Other steps stay pending — the legacy flag wasn't a full-wizard
		// completion signal.
		expect(migrated.onboarding.steps.welcome.status).toBe('pending');
		expect(migrated.onboarding.steps.summary.status).toBe('pending');
		expect(migrated.onboarding.completedAt).toBeNull();
	});

	it('migrates legacy `selected_agent_id` alone (no agent_onboarded flag)', () => {
		const migrated = migrateShellStore(
			{
				activeMode: 'app',
				selected_agent_id: 'codex',
			},
			7
		) as { onboarding: OnboardingState };

		expect(migrated.onboarding.selectedAgentId).toBe('codex');
		// Without the agent_onboarded flag, the step itself isn't marked done.
		expect(migrated.onboarding.steps.agent.status).toBe('pending');
	});

	it('merges over defaults when persisted blob already has a partial onboarding slice', () => {
		const partial = createDefaultOnboardingState();
		partial.steps.welcome = { status: 'completed', completedAt: 123 };
		// Intentionally omit a step from the persisted record to simulate a
		// future shape that adds a new step the user hasn't seen yet.
		const stepsMinusOne = { ...partial.steps };
		delete (stepsMinusOne as Record<string, unknown>).telemetry;
		const blob = {
			activeMode: 'app',
			onboarding: { ...partial, steps: stepsMinusOne },
		};

		const migrated = migrateShellStore(blob, 7) as { onboarding: OnboardingState };
		expect(migrated.onboarding.steps.welcome.status).toBe('completed');
		// Missing step got filled in from defaults.
		expect(migrated.onboarding.steps.telemetry.status).toBe('pending');
	});

	it('still honours the v7 activeMode-snap behaviour', () => {
		const migrated = migrateShellStore(
			{
				activeMode: 'mail', // legacy mode no longer in the union
			},
			6
		) as { activeMode: string };
		expect(migrated.activeMode).toBe('app');
	});

	it('clamps a corrupt activeIndex to a valid range', () => {
		const partial = createDefaultOnboardingState();
		partial.activeIndex = 99;
		const migrated = migrateShellStore({ activeMode: 'app', onboarding: partial }, 7) as {
			onboarding: OnboardingState;
		};
		expect(migrated.onboarding.activeIndex).toBe(ONBOARDING_STEPS.length - 1);
	});
});
