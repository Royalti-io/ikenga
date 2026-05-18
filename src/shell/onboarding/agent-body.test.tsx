// agent-body — payload + auth-warning logic.

import { beforeEach, describe, expect, it, vi } from 'vitest';

// `agent-body` imports `EngineLogo` which pulls `@lobehub/icons`. The
// icons package has `@lobehub/ui` as a peer dep, and vitest trips over
// a broken ESM tooltip subpath inside `@lobehub/ui` during module eval.
// We only test pure-logic exports here, so stub the icon component to
// keep the test runtime dependency-free.
vi.mock('@/shell/onboarding/engine-logo', () => ({
	EngineLogo: () => null,
}));

import { createDefaultOnboardingState, useShellStore } from '@/lib/shell/shell-store';
import type { DetectedAgent } from '@/lib/tauri-cmd';

import type { RegistryIndex } from '@/lib/registry/client';

import {
	OFFLINE_PAYLOAD,
	agentToPayload,
	findEngineNoopEntry,
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

	it('offline payload, once committed, pins engine-noop on the store', () => {
		// Post-install side-effect: agent-body's offlineMut.onSuccess writes
		// these into the store. We exercise the store directly — the
		// pkg-install half is covered by the Browse view's flow.
		const store = useShellStore.getState();
		store.setSelectedAgentId(OFFLINE_PAYLOAD.agentId);
		store.setOnboardingPayload('agent', OFFLINE_PAYLOAD);

		const after = useShellStore.getState();
		expect(after.onboarding.selectedAgentId).toBe('engine-noop');
		const payload = after.onboarding.steps.agent.payload as typeof OFFLINE_PAYLOAD;
		expect(payload.display).toMatch(/offline/i);
	});
});

describe('findEngineNoopEntry', () => {
	function makeIndex(names: string[]): RegistryIndex {
		return {
			schema: 1,
			generatedAt: '2026-05-13T00:00:00Z',
			pkgs: names.map((name) => ({
				name,
				latest: '0.1.1',
				kind: 'engine',
				description: `${name} description`,
			})),
		} as unknown as RegistryIndex;
	}

	it('finds the engine-noop entry by its canonical npm name', () => {
		const idx = makeIndex(['@ikenga/pkg-engine-claude-code', '@ikenga/pkg-engine-noop']);
		expect(findEngineNoopEntry(idx)?.name).toBe('@ikenga/pkg-engine-noop');
	});

	it('returns undefined when engine-noop is absent', () => {
		const idx = makeIndex(['@ikenga/pkg-engine-claude-code', '@ikenga/pkg-mcp-iyke']);
		expect(findEngineNoopEntry(idx)).toBeUndefined();
	});
});
