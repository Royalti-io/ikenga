// telemetry-body — default-OFF + toggle persistence.

import { beforeEach, describe, expect, it } from 'vitest';

import {
	DEFAULT_TELEMETRY_PAYLOAD,
	createDefaultOnboardingState,
	useShellStore,
} from '@/lib/shell/shell-store';

import type { TelemetryPayload } from './telemetry-body';

beforeEach(() => {
	useShellStore.setState({ onboarding: createDefaultOnboardingState() });
});

describe('telemetry step', () => {
	it('ships with the OFF default (APPROVAL.md)', () => {
		expect(DEFAULT_TELEMETRY_PAYLOAD.enabled).toBe(false);
	});

	it('records the user flipping the toggle ON', () => {
		const s = useShellStore.getState();
		s.setOnboardingPayload<TelemetryPayload>('telemetry', { enabled: true });
		const after = useShellStore.getState().onboarding.steps.telemetry;
		expect((after.payload as TelemetryPayload).enabled).toBe(true);
	});

	it('persists across simulated re-renders (store survives the read)', () => {
		const s = useShellStore.getState();
		s.setOnboardingPayload<TelemetryPayload>('telemetry', { enabled: true });
		// Simulate a re-render by reading state again.
		const again = useShellStore.getState().onboarding.steps.telemetry;
		expect((again.payload as TelemetryPayload).enabled).toBe(true);
	});

	it('round-trips back to OFF when toggled twice', () => {
		const s = useShellStore.getState();
		s.setOnboardingPayload<TelemetryPayload>('telemetry', { enabled: true });
		s.setOnboardingPayload<TelemetryPayload>('telemetry', { enabled: false });
		const after = useShellStore.getState().onboarding.steps.telemetry;
		expect((after.payload as TelemetryPayload).enabled).toBe(false);
	});

	it('a fresh state has no payload — body falls back to OFF', () => {
		const after = useShellStore.getState().onboarding.steps.telemetry;
		expect(after.payload).toBeUndefined();
	});
});
