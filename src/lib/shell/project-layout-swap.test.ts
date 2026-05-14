// Phase 6 — project-layout-swap orchestrator.
//
// Verifies the swap order (flush + save outgoing → apply incoming) and
// the fresh-default detection that protects users from a "switch to
// new project resets my view" footgun on first visit.

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Stub the modules the swap orchestrator depends on so we can observe
// call order without booting Tauri / SQLite. Each mock returns a
// jest-fn-style spy so the test can assert on calls.

const paneCalls: Array<{ op: 'save' | 'load' | 'hydrate'; project?: string }> = [];
const filesCalls: Array<{ op: 'save' | 'load' | 'apply'; project?: string }> = [];
const panelCalls: Array<{ op: 'save' | 'load' | 'apply'; project?: string }> = [];

vi.mock('@/lib/panes/pane-persistence', () => ({
	flushPaneTreePersist: vi.fn(() => {}),
	loadPaneTree: vi.fn(async (projectId: string) => {
		paneCalls.push({ op: 'load', project: projectId });
		// Return real saved state for project "saved", fresh-default for "fresh".
		if (projectId === 'saved') {
			return {
				root: { type: 'leaf', id: 'l1', tabs: [{ kind: 'route', path: '/inbox' }], activeTabIdx: 0 },
				focusedId: 'l1',
				closedHistory: [],
			};
		}
		return {
			root: { type: 'leaf', id: 'l0', tabs: [{ kind: 'route', path: '/' }], activeTabIdx: 0 },
			focusedId: 'l0',
			closedHistory: [],
		};
	}),
	savePaneTreeNow: vi.fn(async (_snap: unknown, projectId: string) => {
		paneCalls.push({ op: 'save', project: projectId });
	}),
}));

vi.mock('@/lib/shell/files-store', () => {
	const state = {
		expanded: new Set<string>(),
		selectedPath: null as string | null,
		scrollTop: 0,
		showHidden: false,
		showIgnored: false,
		hydratedProjectId: null as string | null,
		snapshot: () => ({
			expanded: [],
			selectedPath: null,
			scrollTop: 0,
			showHidden: false,
			showIgnored: false,
		}),
		applySnapshot: vi.fn((projectId: string, _data: unknown) => {
			filesCalls.push({ op: 'apply', project: projectId });
		}),
	};
	return {
		useFilesStore: { getState: () => state },
		flushFilesStorePersist: vi.fn(() => {}),
		loadFilesStateFor: vi.fn(async (projectId: string) => {
			filesCalls.push({ op: 'load', project: projectId });
			return {
				expanded: [],
				selectedPath: null,
				scrollTop: 0,
				showHidden: false,
				showIgnored: false,
			};
		}),
		saveFilesStoreNow: vi.fn(async (projectId: string, _data: unknown) => {
			filesCalls.push({ op: 'save', project: projectId });
		}),
	};
});

vi.mock('@/lib/shell/panel-sizes', () => ({
	applyPanelSizes: vi.fn((_sizes: [number, number]) => {
		panelCalls.push({ op: 'apply' });
	}),
	flushPanelSizesPersist: vi.fn(() => {}),
	loadPanelSizes: vi.fn(async (projectId: string) => {
		panelCalls.push({ op: 'load', project: projectId });
		return [16, 84] as [number, number];
	}),
}));

vi.mock('@/lib/panes/pane-store', () => {
	const state = {
		root: { type: 'leaf', id: 'l-current', tabs: [{ kind: 'route', path: '/' }], activeTabIdx: 0 },
		focusedId: 'l-current',
		closedHistory: [],
		hydrate: vi.fn((snap: { focusedId: string }) => {
			paneCalls.push({ op: 'hydrate', project: snap.focusedId });
		}),
	};
	return { usePaneStore: { getState: () => state } };
});

import { swapProjectLayout } from './project-layout-swap';

beforeEach(() => {
	paneCalls.length = 0;
	filesCalls.length = 0;
	panelCalls.length = 0;
});

describe('swapProjectLayout', () => {
	it('saves outgoing then loads + applies incoming', async () => {
		await swapProjectLayout('outgoing', 'saved');

		// Outgoing must have been saved.
		expect(paneCalls.some((c) => c.op === 'save' && c.project === 'outgoing')).toBe(true);
		expect(filesCalls.some((c) => c.op === 'save' && c.project === 'outgoing')).toBe(true);

		// Incoming must have been loaded.
		expect(paneCalls.some((c) => c.op === 'load' && c.project === 'saved')).toBe(true);
		expect(filesCalls.some((c) => c.op === 'load' && c.project === 'saved')).toBe(true);
		expect(panelCalls.some((c) => c.op === 'load' && c.project === 'saved')).toBe(true);

		// And applied — pane tree got hydrated, files snapshot got applied,
		// panel sizes got pushed back into React via the setter.
		expect(paneCalls.some((c) => c.op === 'hydrate')).toBe(true);
		expect(filesCalls.some((c) => c.op === 'apply' && c.project === 'saved')).toBe(true);
		expect(panelCalls.some((c) => c.op === 'apply')).toBe(true);
	});

	it('skips pane-tree hydrate when incoming has no saved layout (fresh-default)', async () => {
		await swapProjectLayout('outgoing', 'fresh');

		// Load happened.
		expect(paneCalls.some((c) => c.op === 'load' && c.project === 'fresh')).toBe(true);
		// But hydrate did NOT — the fresh-default check kept the current view.
		expect(paneCalls.some((c) => c.op === 'hydrate')).toBe(false);

		// Files-explorer and panel-sizes always apply (they're cheap).
		expect(filesCalls.some((c) => c.op === 'apply' && c.project === 'fresh')).toBe(true);
		expect(panelCalls.some((c) => c.op === 'apply')).toBe(true);
	});

	it('is a no-op when outgoing === incoming', async () => {
		await swapProjectLayout('same', 'same');
		expect(paneCalls).toHaveLength(0);
		expect(filesCalls).toHaveLength(0);
		expect(panelCalls).toHaveLength(0);
	});
});
