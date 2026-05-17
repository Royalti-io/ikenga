import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTerminalStore } from './session-store';

// The store loads `@tauri-apps/plugin-sql` lazily on persist; mocking it
// keeps the tests offline. Failure to load falls back to localStorage
// (also fine in jsdom).
vi.mock('@tauri-apps/plugin-sql', () => ({
	default: {
		load: async () => {
			throw new Error('sql disabled in tests');
		},
	},
}));

function reset() {
	useTerminalStore.setState({ tabs: [], activeId: null, rehydrated: false });
}

describe('useTerminalStore ownership', () => {
	beforeEach(reset);

	it('add() defaults owner to sidepane', () => {
		const id = useTerminalStore.getState().add({ cwd: '/tmp', cmd: ['bash'] });
		const tab = useTerminalStore.getState().tabs.find((t) => t.id === id)!;
		expect(tab.owner).toEqual({ kind: 'sidepane' });
	});

	it('attachToStudio transitions ownership to studio', () => {
		const id = useTerminalStore.getState().add({ cwd: '/tmp', cmd: ['bash'] });
		const res = useTerminalStore.getState().attachToStudio(id, 'pane-1', '/a.html');
		expect(res).toEqual({ ok: true });
		const tab = useTerminalStore.getState().tabs.find((t) => t.id === id)!;
		expect(tab.owner).toEqual({ kind: 'studio', paneId: 'pane-1', artifactPath: '/a.html' });
	});

	it('re-attach from same pane succeeds idempotently', () => {
		const id = useTerminalStore.getState().add({ cwd: '/tmp', cmd: ['bash'] });
		useTerminalStore.getState().attachToStudio(id, 'pane-1', '/a.html');
		const res = useTerminalStore.getState().attachToStudio(id, 'pane-1', '/a.html');
		expect(res).toEqual({ ok: true });
	});

	it('re-attach from different pane returns conflict', () => {
		const id = useTerminalStore.getState().add({ cwd: '/tmp', cmd: ['bash'] });
		useTerminalStore.getState().attachToStudio(id, 'pane-1', '/a.html');
		const res = useTerminalStore.getState().attachToStudio(id, 'pane-2', '/b.html');
		expect(res).toEqual({ ok: false, requiresConfirm: true, previousPaneId: 'pane-1' });
		// Ownership must NOT have changed on a refused attach.
		const tab = useTerminalStore.getState().tabs.find((t) => t.id === id)!;
		expect(tab.owner).toMatchObject({ kind: 'studio', paneId: 'pane-1' });
	});

	it('force-attach from different pane overrides', () => {
		const id = useTerminalStore.getState().add({ cwd: '/tmp', cmd: ['bash'] });
		useTerminalStore.getState().attachToStudio(id, 'pane-1', '/a.html');
		const res = useTerminalStore
			.getState()
			.attachToStudio(id, 'pane-2', '/b.html', { force: true });
		expect(res).toEqual({ ok: true });
		const tab = useTerminalStore.getState().tabs.find((t) => t.id === id)!;
		expect(tab.owner).toEqual({ kind: 'studio', paneId: 'pane-2', artifactPath: '/b.html' });
	});

	it('detachFromStudio restores sidepane ownership', () => {
		const id = useTerminalStore.getState().add({ cwd: '/tmp', cmd: ['bash'] });
		useTerminalStore.getState().attachToStudio(id, 'pane-1', '/a.html');
		useTerminalStore.getState().detachFromStudio(id);
		const tab = useTerminalStore.getState().tabs.find((t) => t.id === id)!;
		expect(tab.owner).toEqual({ kind: 'sidepane' });
	});

	it('detach on already-sidepane is a no-op', () => {
		const id = useTerminalStore.getState().add({ cwd: '/tmp', cmd: ['bash'] });
		useTerminalStore.getState().detachFromStudio(id);
		const tab = useTerminalStore.getState().tabs.find((t) => t.id === id)!;
		expect(tab.owner).toEqual({ kind: 'sidepane' });
	});

	it('findStudioAttachment returns the right tab', () => {
		const a = useTerminalStore.getState().add({ cwd: '/tmp', cmd: ['bash'] });
		const b = useTerminalStore.getState().add({ cwd: '/tmp', cmd: ['claude'] });
		useTerminalStore.getState().attachToStudio(b, 'pane-9', '/x.html');
		expect(useTerminalStore.getState().findStudioAttachment('pane-9')?.id).toBe(b);
		expect(useTerminalStore.getState().findStudioAttachment('pane-1')).toBeNull();
		// `a` was never attached.
		expect(useTerminalStore.getState().tabs.find((t) => t.id === a)!.owner.kind).toBe('sidepane');
	});
});
