// Phase 9 (ACP migration): tests for the per-thread badge counts store.

import { afterEach, describe, expect, it } from 'vitest';

import { useThreadBadges } from './thread-badges-store';

afterEach(() => {
	useThreadBadges.getState().clearAll();
});

describe('useThreadBadges', () => {
	it('starts with no counts', () => {
		expect(useThreadBadges.getState().counts).toEqual({});
	});

	it('bumps a thread to 1 then increments on subsequent bumps', () => {
		const s = useThreadBadges.getState();
		s.bump('t_1');
		expect(useThreadBadges.getState().counts.t_1).toBe(1);
		s.bump('t_1');
		s.bump('t_1');
		expect(useThreadBadges.getState().counts.t_1).toBe(3);
	});

	it('tracks bumps for different threads independently', () => {
		const s = useThreadBadges.getState();
		s.bump('t_1');
		s.bump('t_2');
		s.bump('t_2');
		expect(useThreadBadges.getState().counts).toEqual({ t_1: 1, t_2: 2 });
	});

	it('clear removes a thread entirely from the map', () => {
		// We want 0-count threads to drop OUT of the map so selector
		// iteration in the UI stays O(active-only). Verify the key is
		// actually gone — not just set to 0.
		const s = useThreadBadges.getState();
		s.bump('t_1');
		s.bump('t_2');
		s.clear('t_1');
		expect(useThreadBadges.getState().counts).toEqual({ t_2: 1 });
		expect('t_1' in useThreadBadges.getState().counts).toBe(false);
	});

	it('clear on an absent thread is a no-op (no spurious set)', () => {
		const s = useThreadBadges.getState();
		const before = useThreadBadges.getState().counts;
		s.clear('never_existed');
		// Object identity should be preserved when nothing changed (so
		// shallow-equal Zustand subscribers don't fire).
		expect(useThreadBadges.getState().counts).toBe(before);
	});

	it('clearAll wipes every count', () => {
		const s = useThreadBadges.getState();
		s.bump('t_1');
		s.bump('t_2');
		s.clearAll();
		expect(useThreadBadges.getState().counts).toEqual({});
	});
});
