// Single source of truth for a step's read/write into the wizard store.
//
// Every Phase 4+ step body should consume this hook rather than reaching
// into `useShellStore` directly — that way step-local state lives in one
// place and the wizard chrome (next/back/skip) drives status transitions
// without each step needing to remember the dance.

import { useCallback } from 'react';

import {
	type OnboardingStepId,
	type OnboardingStepRecord,
	OPTIONAL_ONBOARDING_STEPS,
	useShellStore,
} from '@/lib/shell/shell-store';

export interface UseOnboardingStepResult<P> {
	record: OnboardingStepRecord<P>;
	setPayload: (payload: P) => void;
	markCompleted: () => void;
	markSkipped: () => void;
	isOptional: boolean;
}

export function useOnboardingStep<P = unknown>(
	stepId: OnboardingStepId
): UseOnboardingStepResult<P> {
	const record = useShellStore((s) => s.onboarding.steps[stepId]) as OnboardingStepRecord<P>;
	const setOnboardingPayload = useShellStore((s) => s.setOnboardingPayload);
	const markOnboardingStepCompleted = useShellStore((s) => s.markOnboardingStepCompleted);
	const markOnboardingStepSkipped = useShellStore((s) => s.markOnboardingStepSkipped);

	const setPayload = useCallback(
		(payload: P) => setOnboardingPayload(stepId, payload),
		[stepId, setOnboardingPayload]
	);
	const markCompleted = useCallback(
		() => markOnboardingStepCompleted(stepId),
		[stepId, markOnboardingStepCompleted]
	);
	const markSkipped = useCallback(
		() => markOnboardingStepSkipped(stepId),
		[stepId, markOnboardingStepSkipped]
	);

	return {
		record,
		setPayload,
		markCompleted,
		markSkipped,
		isOptional: OPTIONAL_ONBOARDING_STEPS.has(stepId),
	};
}
