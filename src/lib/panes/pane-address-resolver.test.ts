import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted mock — vitest's vi.mock is hoisted to the top of the module.
// State is captured by closure and reached via the imports below.
vi.mock('@/lib/tauri-cmd', () => {
	const state = {
		pins: new Map<
			string,
			{ id: string; target: string; manifestId: string | null }
		>(),
		touchedIds: [] as string[],
	};
	return {
		__state: state,
		activityPinsResolveArtifact: vi.fn(async (manifestId: string) => {
			for (const pin of state.pins.values()) {
				if (pin.manifestId === manifestId) {
					return {
						...pin,
						kind: 'artifact',
						label: pin.manifestId,
						iconLucide: null,
						iconEmoji: null,
						sectionId: null,
						sortOrder: 0,
						createdAt: '2026-05-15T00:00:00Z',
						lastOpenedAt: null,
					};
				}
			}
			return null;
		}),
		activityPinsTouchOpen: vi.fn(async (pinId: string) => {
			state.touchedIds.push(pinId);
		}),
	};
});

// Imported AFTER vi.mock so the resolver picks up the mocked module.
import * as cmd from '@/lib/tauri-cmd';
import { resolveArtifactAddress } from './pane-address-resolver';
import type { PaneView } from './types';

// Cast to surface the test-only state without leaking it through the
// production typings.
const mocked = cmd as typeof cmd & {
	__state: {
		pins: Map<string, { id: string; target: string; manifestId: string | null }>;
		touchedIds: string[];
	};
};

beforeEach(() => {
	mocked.__state.pins.clear();
	mocked.__state.touchedIds.length = 0;
	vi.mocked(cmd.activityPinsResolveArtifact).mockClear();
	vi.mocked(cmd.activityPinsTouchOpen).mockClear();
});

describe('resolveArtifactAddress', () => {
	it('passes through non-artifact views without calling the host', async () => {
		const view: PaneView = { kind: 'route', path: '/inbox' };
		const result = await resolveArtifactAddress(view);
		expect(result).toEqual({ view, resolved: false });
		expect(cmd.activityPinsResolveArtifact).not.toHaveBeenCalled();
	});

	it('passes through artifact views with a real path', async () => {
		const view: PaneView = { kind: 'artifact', path: '/tmp/x.html' };
		const result = await resolveArtifactAddress(view);
		expect(result).toEqual({ view, resolved: false });
		expect(cmd.activityPinsResolveArtifact).not.toHaveBeenCalled();
	});

	it('resolves ikenga://artifact/<id> to the pinned target path', async () => {
		mocked.__state.pins.set('p1', {
			id: 'p1',
			target: '/home/me/cfo.html',
			manifestId: 'cfo-daily',
		});
		const result = await resolveArtifactAddress({
			kind: 'artifact',
			path: 'ikenga://artifact/cfo-daily',
		});
		expect(result.resolved).toBe(true);
		expect(result.view).toEqual({ kind: 'artifact', path: '/home/me/cfo.html' });
	});

	it('returns null on miss and signals it tried', async () => {
		const result = await resolveArtifactAddress({
			kind: 'artifact',
			path: 'ikenga://artifact/nope',
		});
		expect(result).toEqual({ view: null, resolved: true });
	});

	it('returns null when the URI has an empty id', async () => {
		const result = await resolveArtifactAddress({
			kind: 'artifact',
			path: 'ikenga://artifact/',
		});
		expect(result).toEqual({ view: null, resolved: true });
		// Don't even bother the host with an empty id — parser should have
		// rejected it, but be defensive at the resolver too.
		expect(cmd.activityPinsResolveArtifact).not.toHaveBeenCalled();
	});

	it('fires touch_open on hit (best-effort)', async () => {
		mocked.__state.pins.set('p2', {
			id: 'p2',
			target: '/x',
			manifestId: 'x',
		});
		await resolveArtifactAddress({ kind: 'artifact', path: 'ikenga://artifact/x' });
		// touch_open is fire-and-forget (void); flush microtasks to let it run.
		await new Promise<void>((r) => setTimeout(r, 0));
		expect(mocked.__state.touchedIds).toEqual(['p2']);
	});

	it('does not fire touch_open on miss', async () => {
		await resolveArtifactAddress({ kind: 'artifact', path: 'ikenga://artifact/missing' });
		await new Promise<void>((r) => setTimeout(r, 0));
		expect(mocked.__state.touchedIds).toEqual([]);
		expect(cmd.activityPinsTouchOpen).not.toHaveBeenCalled();
	});

	it('swallows touch_open failures so navigation still proceeds', async () => {
		mocked.__state.pins.set('p3', {
			id: 'p3',
			target: '/y',
			manifestId: 'y',
		});
		vi.mocked(cmd.activityPinsTouchOpen).mockRejectedValueOnce(new Error('db locked'));
		const result = await resolveArtifactAddress({
			kind: 'artifact',
			path: 'ikenga://artifact/y',
		});
		expect(result.view).toEqual({ kind: 'artifact', path: '/y' });
		// Wait a tick for the swallowed promise to settle without us crashing.
		await new Promise<void>((r) => setTimeout(r, 0));
	});
});
