// scaffolding-body — payload / skip-state shape.
//
// No DOM env, so we test the persisted payload shape. The UI surface
// (preview card / existing-dir choice rows / scaffold-now button) is
// exercised against the Phase 1 prototype and via the manual smoke pass
// the doc calls out in the acceptance section.

import { beforeEach, describe, expect, it } from 'vitest';

import {
	createDefaultOnboardingState,
	useShellStore,
} from '@/lib/shell/shell-store';

import type { ScaffoldingPayload } from './scaffolding-body';

beforeEach(() => {
	useShellStore.setState({ onboarding: createDefaultOnboardingState() });
});

describe('scaffolding step — store payload', () => {
	it('records the n/a payload when the agent is not claude-code', () => {
		const s = useShellStore.getState();
		const payload: ScaffoldingPayload = {
			choice: 'na',
			rootPath: null,
			profile: 'none',
			at: 1_700_000_000_000,
		};
		s.setOnboardingPayload('scaffolding', payload);
		s.markOnboardingStepSkipped('scaffolding');

		const after = useShellStore.getState().onboarding.steps.scaffolding;
		expect(after.status).toBe('skipped');
		expect((after.payload as ScaffoldingPayload).choice).toBe('na');
	});

	it('records the scaffold choice when the user accepts the starter pack', () => {
		const s = useShellStore.getState();
		const payload: ScaffoldingPayload = {
			choice: 'scaffold',
			rootPath: '~/royalti-co/ikenga',
			profile: 'starter',
			at: 1_700_000_000_000,
		};
		s.setOnboardingPayload('scaffolding', payload);
		s.markOnboardingStepCompleted('scaffolding');

		const after = useShellStore.getState().onboarding.steps.scaffolding;
		expect(after.status).toBe('completed');
		expect((after.payload as ScaffoldingPayload).rootPath).toBe('~/royalti-co/ikenga');
		expect((after.payload as ScaffoldingPayload).profile).toBe('starter');
	});

	it('records the merge choice when .claude/ already exists', () => {
		const s = useShellStore.getState();
		const payload: ScaffoldingPayload = {
			choice: 'merge',
			rootPath: '~/royalti-co/ikenga',
			profile: 'starter',
			at: 1_700_000_000_000,
		};
		s.setOnboardingPayload('scaffolding', payload);
		s.markOnboardingStepCompleted('scaffolding');

		const after = useShellStore.getState().onboarding.steps.scaffolding;
		expect((after.payload as ScaffoldingPayload).choice).toBe('merge');
	});

	it('records the skip choice', () => {
		const s = useShellStore.getState();
		const payload: ScaffoldingPayload = {
			choice: 'skip',
			rootPath: '~/royalti-co/ikenga',
			profile: 'none',
			at: 1_700_000_000_000,
		};
		s.setOnboardingPayload('scaffolding', payload);
		s.markOnboardingStepSkipped('scaffolding');

		const after = useShellStore.getState().onboarding.steps.scaffolding;
		expect(after.status).toBe('skipped');
		expect((after.payload as ScaffoldingPayload).choice).toBe('skip');
	});
});
