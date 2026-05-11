// agent-body — payload + auth-warning logic.

import { beforeEach, describe, expect, it } from 'vitest';

import {
	createDefaultOnboardingState,
	useShellStore,
} from '@/lib/shell/shell-store';
import type { DetectedAgent } from '@/lib/tauri-cmd';

import {
	OFFLINE_PAYLOAD,
	agentToPayload,
	shouldShowAuthWarning,
} from './agent-body';

beforeEach(() => {
	useShellStore.setState({ onboarding: createDefaultOnboardingState() });
});

function makeAgent(overrides: Partial<DetectedAgent>): DetectedAgent {
	return {
		id: 'claude-code',
		display: 'Claude Code',
		executable_path: '/usr/local/bin/claude',
		version: '1.0.84',
		authed: true,
		auth_hint: null,
		capabilities: {
			streaming: true,
			tool_use: true,
			thinking: true,
			artifacts: true,
			mcp: true,
			session_resume: true,
		},
		...overrides,
	};
}

describe('agentToPayload', () => {
	it('maps a detected agent to its persisted payload shape', () => {
		const agent = makeAgent({});
		expect(agentToPayload(agent)).toEqual({
			agentId: 'claude-code',
			display: 'Claude Code',
			executablePath: '/usr/local/bin/claude',
			version: '1.0.84',
			authed: true,
		});
	});

	it('carries a null version through', () => {
		const agent = makeAgent({ version: null });
		expect(agentToPayload(agent).version).toBeNull();
	});
});

describe('shouldShowAuthWarning', () => {
	it('shows the banner only when authed === false', () => {
		expect(shouldShowAuthWarning(makeAgent({ authed: false }))).toBe(true);
	});

	it('hides the banner when authed === true', () => {
		expect(shouldShowAuthWarning(makeAgent({ authed: true }))).toBe(false);
	});

	it('hides the banner when authed is unknown (null)', () => {
		expect(shouldShowAuthWarning(makeAgent({ authed: null }))).toBe(false);
	});

	it('hides the banner when there is no selected agent', () => {
		expect(shouldShowAuthWarning(null)).toBe(false);
		expect(shouldShowAuthWarning(undefined)).toBe(false);
	});
});

describe('OFFLINE_PAYLOAD', () => {
	it('points at the engine-noop pkg id (APPROVAL.md lock)', () => {
		expect(OFFLINE_PAYLOAD.agentId).toBe('engine-noop');
	});
});

describe('store interaction', () => {
	it('persists the selected agent id and payload', () => {
		const agent = makeAgent({});
		const store = useShellStore.getState();
		store.setSelectedAgentId(agent.id);
		store.setOnboardingPayload('agent', agentToPayload(agent));

		const after = useShellStore.getState();
		expect(after.onboarding.selectedAgentId).toBe('claude-code');
		const payload = after.onboarding.steps.agent.payload as ReturnType<typeof agentToPayload>;
		expect(payload.agentId).toBe('claude-code');
		expect(payload.executablePath).toBe('/usr/local/bin/claude');
	});

	it('offline mode sets engine-noop without installing a pkg', () => {
		const store = useShellStore.getState();
		store.setSelectedAgentId(OFFLINE_PAYLOAD.agentId);
		store.setOnboardingPayload('agent', OFFLINE_PAYLOAD);

		const after = useShellStore.getState();
		expect(after.onboarding.selectedAgentId).toBe('engine-noop');
		const payload = after.onboarding.steps.agent.payload as typeof OFFLINE_PAYLOAD;
		expect(payload.display).toMatch(/offline/i);
	});
});
