// WizardStepper logic — Phase 3 scaffold.
//
// We deliberately don't render the React tree here: the shell vitest setup
// has no DOM env (no jsdom/happy-dom, no @testing-library/react). Instead
// we drive the underlying store actions and the index math that the stepper
// commits to — those are the load-bearing pieces. The pure-React layout is
// exercised manually + via the Phase 1 prototypes; the dynamic decisions
// live in the store.

import { beforeEach, describe, expect, it } from 'vitest';

import {
	ONBOARDING_STEPS,
	OPTIONAL_ONBOARDING_STEPS,
	type OnboardingStepId,
	createDefaultOnboardingState,
	useShellStore,
} from '@/lib/shell/shell-store';

beforeEach(() => {
	useShellStore.setState({ onboarding: createDefaultOnboardingState() });
});

// Mirrors the index math inside <WizardStepper>. Centralised here so the
// tests fail loud if the chrome diverges.
function simulateGoNext(stepId: OnboardingStepId) {
	const store = useShellStore.getState();
	store.markOnboardingStepCompleted(stepId);
	const idx = ONBOARDING_STEPS.indexOf(stepId);
	const nextIdx = Math.min(ONBOARDING_STEPS.length - 1, idx + 1);
	store.setOnboardingActiveIndex(nextIdx);
}

function simulateGoBack(stepId: OnboardingStepId) {
	const store = useShellStore.getState();
	const idx = ONBOARDING_STEPS.indexOf(stepId);
	const prevIdx = Math.max(0, idx - 1);
	store.setOnboardingActiveIndex(prevIdx);
}

function simulateSkip(stepId: OnboardingStepId) {
	const store = useShellStore.getState();
	store.markOnboardingStepSkipped(stepId);
	const idx = ONBOARDING_STEPS.indexOf(stepId);
	const nextIdx = Math.min(ONBOARDING_STEPS.length - 1, idx + 1);
	store.setOnboardingActiveIndex(nextIdx);
}

function simulateGoTo(stepId: OnboardingStepId) {
	useShellStore.getState().enterOnboardingEdit(stepId);
}

describe('WizardStepper — progress rail', () => {
	it('renders N steps from canonical ordering', () => {
		expect(ONBOARDING_STEPS).toEqual([
			'welcome',
			'agent',
			'roots',
			'packages',
			'connectors',
			'scaffolding',
			'appearance',
			'telemetry',
			'summary',
		]);
		const state = useShellStore.getState().onboarding;
		expect(Object.keys(state.steps)).toHaveLength(ONBOARDING_STEPS.length);
		for (const id of ONBOARDING_STEPS) {
			expect(state.steps[id].status).toBe('pending');
		}
	});

	it('exposes optional vs. required steps for the skip affordance', () => {
		expect(OPTIONAL_ONBOARDING_STEPS.has('welcome')).toBe(false);
		expect(OPTIONAL_ONBOARDING_STEPS.has('summary')).toBe(false);
		expect(OPTIONAL_ONBOARDING_STEPS.has('agent')).toBe(false);
		expect(OPTIONAL_ONBOARDING_STEPS.has('connectors')).toBe(true);
		expect(OPTIONAL_ONBOARDING_STEPS.has('telemetry')).toBe(true);
	});
});

describe('WizardStepper — goNext', () => {
	it('advances activeIndex and marks the current step completed', () => {
		simulateGoNext('welcome');
		const ob = useShellStore.getState().onboarding;
		expect(ob.activeIndex).toBe(1);
		expect(ob.steps.welcome.status).toBe('completed');
		expect(typeof ob.steps.welcome.completedAt).toBe('number');
		// Next step still pending.
		expect(ob.steps.agent.status).toBe('pending');
	});

	it('clamps activeIndex on the final step (no overflow)', () => {
		// Walk all the way to summary.
		for (const id of ONBOARDING_STEPS.slice(0, -1)) {
			simulateGoNext(id);
		}
		expect(useShellStore.getState().onboarding.activeIndex).toBe(ONBOARDING_STEPS.length - 1);
		simulateGoNext('summary');
		expect(useShellStore.getState().onboarding.activeIndex).toBe(ONBOARDING_STEPS.length - 1);
	});
});

describe('WizardStepper — goBack', () => {
	it('decrements activeIndex and does NOT clear completed status', () => {
		// Forward to step 2, then back.
		simulateGoNext('welcome'); // activeIndex 1
		simulateGoBack('agent');
		const ob = useShellStore.getState().onboarding;
		expect(ob.activeIndex).toBe(0);
		// Completion status survives the back-step.
		expect(ob.steps.welcome.status).toBe('completed');
	});

	it('clamps activeIndex at 0 (no underflow)', () => {
		simulateGoBack('welcome');
		expect(useShellStore.getState().onboarding.activeIndex).toBe(0);
	});
});

describe('WizardStepper — skip', () => {
	it('marks an optional step as skipped and advances', () => {
		useShellStore.getState().setOnboardingActiveIndex(ONBOARDING_STEPS.indexOf('connectors'));
		simulateSkip('connectors');
		const ob = useShellStore.getState().onboarding;
		expect(ob.steps.connectors.status).toBe('skipped');
		expect(typeof ob.steps.connectors.completedAt).toBe('number');
		expect(ob.activeIndex).toBe(ONBOARDING_STEPS.indexOf('scaffolding'));
	});

	it('refuses to skip a required step (defence in depth)', () => {
		// The agent step is required. The store action no-ops, so status
		// stays pending even if a caller mistakenly hits markSkipped.
		useShellStore.getState().markOnboardingStepSkipped('agent');
		expect(useShellStore.getState().onboarding.steps.agent.status).toBe('pending');
	});
});

describe('WizardStepper — goTo (Settings re-entry)', () => {
	it('jumps to the target step and switches to edit mode', () => {
		simulateGoTo('appearance');
		const ob = useShellStore.getState().onboarding;
		expect(ob.activeIndex).toBe(ONBOARDING_STEPS.indexOf('appearance'));
		expect(ob.mode).toBe('edit');
	});

	it('ignores unknown step ids', () => {
		const before = useShellStore.getState().onboarding;
		useShellStore.getState().enterOnboardingEdit('not-a-step' as OnboardingStepId);
		const after = useShellStore.getState().onboarding;
		expect(after.activeIndex).toBe(before.activeIndex);
		expect(after.mode).toBe(before.mode);
	});
});

describe('WizardStepper — payload round-trip', () => {
	it('reads back what a step wrote', () => {
		interface AgentPayload {
			agentId: string;
			version: string;
		}
		useShellStore.getState().setOnboardingPayload<AgentPayload>('agent', {
			agentId: 'claude-code',
			version: '1.0.84',
		});
		const record = useShellStore.getState().onboarding.steps.agent;
		expect(record.payload).toEqual({ agentId: 'claude-code', version: '1.0.84' });
	});
});

describe('WizardStepper — finishOnboarding', () => {
	it('stamps completedAt and parks on the summary step', () => {
		useShellStore.getState().finishOnboarding();
		const ob = useShellStore.getState().onboarding;
		expect(typeof ob.completedAt).toBe('number');
		expect(ob.activeIndex).toBe(ONBOARDING_STEPS.length - 1);
	});
});
