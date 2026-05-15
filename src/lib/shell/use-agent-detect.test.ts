// useAgentDetect — state-transition tests against the exposed reducer
// helpers. The full hook lives behind `useState`/`useEffect` plumbing
// that `@testing-library/react` would normally exercise, but it isn't a
// dep of this project (see use-pane-history.test.ts for the same
// pattern). Covering the run-token guard + entry mapping directly gives
// us the same confidence without the dep.

import { describe, expect, it } from 'vitest';

import type { DetectedAgent } from '@/lib/tauri-cmd';

import { applyProbeResult, entryFromProbe, pendingMap } from './use-agent-detect';

function makeAgent(id: string): DetectedAgent {
	return {
		id,
		display: id,
		executable_path: `/usr/local/bin/${id}`,
		version: '1.0.0',
		authed: true,
		auth_hint: null,
		capabilities: {
			streaming: true,
			tool_use: true,
			thinking: false,
			artifacts: false,
			mcp: false,
			session_resume: false,
		},
	};
}

describe('pendingMap', () => {
	it('seeds every requested id as pending', () => {
		const map = pendingMap(['claude-code', 'codex']);
		expect(map['claude-code'].status).toBe('pending');
		expect(map.codex.status).toBe('pending');
	});
});

describe('entryFromProbe', () => {
	it('returns detected when an agent is supplied', () => {
		const entry = entryFromProbe(makeAgent('claude-code'));
		expect(entry.status).toBe('detected');
		expect(entry.agent?.executable_path).toBe('/usr/local/bin/claude-code');
	});

	it('returns missing when the probe resolves to null', () => {
		const entry = entryFromProbe(null);
		expect(entry.status).toBe('missing');
		expect(entry.error).toBeUndefined();
	});

	it('returns missing with the error message when the probe rejects', () => {
		const entry = entryFromProbe(null, new Error('boom'));
		expect(entry.status).toBe('missing');
		expect(entry.error).toContain('boom');
	});
});

describe('applyProbeResult (run-token guard)', () => {
	const seed = pendingMap(['claude-code', 'codex']);

	it('flips a single entry when the token matches the current run', () => {
		const next = applyProbeResult(
			seed,
			'claude-code',
			entryFromProbe(makeAgent('claude-code')),
			1,
			1
		);
		expect(next['claude-code'].status).toBe('detected');
		expect(next.codex.status).toBe('pending');
	});

	it('drops resolutions from a superseded run (pending → detected → pending)', () => {
		const afterRefresh = pendingMap(['claude-code']);
		const stale = applyProbeResult(
			afterRefresh,
			'claude-code',
			entryFromProbe(makeAgent('claude-code')),
			1, // stale token — first run
			2 // current token — second run
		);
		expect(stale['claude-code'].status).toBe('pending');
	});

	it('idempotently flips a card from pending → detected → missing across two runs', () => {
		let map = pendingMap(['claude-code']);
		map = applyProbeResult(map, 'claude-code', entryFromProbe(makeAgent('claude-code')), 1, 1);
		expect(map['claude-code'].status).toBe('detected');

		// refresh() resets the map and bumps the token.
		map = pendingMap(['claude-code']);
		expect(map['claude-code'].status).toBe('pending');

		map = applyProbeResult(map, 'claude-code', entryFromProbe(null), 2, 2);
		expect(map['claude-code'].status).toBe('missing');
	});

	it('mapping the same id twice in one run keeps the latest value', () => {
		let map = pendingMap(['claude-code']);
		map = applyProbeResult(map, 'claude-code', entryFromProbe(null), 1, 1);
		expect(map['claude-code'].status).toBe('missing');
		map = applyProbeResult(map, 'claude-code', entryFromProbe(makeAgent('claude-code')), 1, 1);
		expect(map['claude-code'].status).toBe('detected');
	});
});
