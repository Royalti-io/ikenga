import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the Tauri seams the store talks to. `listen` resolves to a no-op
// unlisten; `listWindows` / `closeWindow` are controllable per-test.
vi.mock('@tauri-apps/api/event', () => ({
	listen: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock('@/lib/tauri-cmd', () => ({
	listWindows: vi.fn(),
	closeWindow: vi.fn(() => Promise.resolve()),
}));
// Primary window by default (the tracker no-ops in a detached window).
vi.mock('./window-context', () => ({ isDetachedWindow: () => false }));

import type { WindowDescriptor } from '@ikenga/contract';
import { closeWindow, listWindows } from '@/lib/tauri-cmd';
import {
	clearPendingReclaimNudge,
	hasPendingReclaimNudge,
	markSurfaceDetached,
	reclaimSurface,
	syncDetachedSurfaces,
	useDetachedSurfaces,
} from './detached-surfaces';

const mockListWindows = vi.mocked(listWindows);
const mockCloseWindow = vi.mocked(closeWindow);

function descriptor(label: string, surfaces: string[]): WindowDescriptor {
	return { label, kind: 'single-surface', surface_set: surfaces, project_id: null, layout_key: label };
}

function isDetached(surfaceId: string): boolean {
	return surfaceId in useDetachedSurfaces.getState().surfaceToWindow;
}

// The `pendingReclaimNudge` Set is module-scope and survives between tests, so
// clear every id the suite touches up front — otherwise an arm in one test
// leaks into the next.
const NUDGE_IDS = ['terminal:pty-1', 'terminal:pty-9', 'chat:thread-a', 'viewer:/a.md'];

beforeEach(() => {
	useDetachedSurfaces.setState({ surfaceToWindow: {} });
	for (const id of NUDGE_IDS) clearPendingReclaimNudge(id);
	mockListWindows.mockReset();
	mockCloseWindow.mockReset();
	mockCloseWindow.mockResolvedValue(undefined);
});

describe('syncDetachedSurfaces', () => {
	it('maps every detached window surface to its hosting label, skipping main', async () => {
		mockListWindows.mockResolvedValue([
			descriptor('detached-chat-1', ['chat:thread-a']),
			descriptor('detached-terminal-1', ['terminal:pty-9']),
			// `main` (if ever listed) must never count as detached.
			descriptor('main', ['chat:thread-a']),
		]);

		await syncDetachedSurfaces();

		expect(isDetached('chat:thread-a')).toBe(true);
		expect(isDetached('terminal:pty-9')).toBe(true);
		expect(useDetachedSurfaces.getState().surfaceToWindow['chat:thread-a']).toBe('detached-chat-1');
		expect(isDetached('viewer:/no/such')).toBe(false);
	});

	it('drops surfaces whose windows have closed (full rebuild, not merge)', async () => {
		markSurfaceDetached('chat:thread-a', 'detached-chat-1');
		expect(isDetached('chat:thread-a')).toBe(true);

		// The window closed → registry no longer lists it.
		mockListWindows.mockResolvedValue([]);
		await syncDetachedSurfaces();

		expect(isDetached('chat:thread-a')).toBe(false);
	});

	it('preserves prior state when the registry list call rejects', async () => {
		markSurfaceDetached('viewer:/a.md', 'detached-viewer-1');
		mockListWindows.mockRejectedValue(new Error('ipc down'));

		await syncDetachedSurfaces();

		expect(isDetached('viewer:/a.md')).toBe(true);
	});
});

describe('markSurfaceDetached', () => {
	it('optimistically records a surface as detached before the event lands', () => {
		expect(isDetached('terminal:pty-1')).toBe(false);
		markSurfaceDetached('terminal:pty-1', 'detached-terminal-1');
		expect(isDetached('terminal:pty-1')).toBe(true);
	});
});

describe('reclaimSurface', () => {
	it('closes the hosting window and clears the surface from the map', async () => {
		markSurfaceDetached('chat:thread-a', 'detached-chat-1');

		await reclaimSurface('chat:thread-a');

		expect(mockCloseWindow).toHaveBeenCalledWith('detached-chat-1');
		expect(isDetached('chat:thread-a')).toBe(false);
	});

	it('no-ops when the surface is not detached', async () => {
		await reclaimSurface('chat:not-open');
		expect(mockCloseWindow).not.toHaveBeenCalled();
	});

	it('reconciles from the registry if the close call fails', async () => {
		markSurfaceDetached('chat:thread-a', 'detached-chat-1');
		mockCloseWindow.mockRejectedValue(new Error('close failed'));
		// The window genuinely closed despite the error → registry lists none.
		mockListWindows.mockResolvedValue([]);

		await reclaimSurface('chat:thread-a');

		expect(isDetached('chat:thread-a')).toBe(false);
	});
});

// T-3a (reclaim half of T-2): a reclaim arms a one-shot SIGWINCH nudge that
// TerminalView consumes on remount. Only `terminal:` surfaces are armed —
// TerminalView is the sole consumer and therefore the sole caller of
// `clearPendingReclaimNudge`, so arming a chat/viewer surface would leak a Set
// slot that nothing ever clears.
describe('pendingReclaimNudge (T-3a reclaim arming)', () => {
	it('arms the nudge when a terminal surface is reclaimed via the button', async () => {
		markSurfaceDetached('terminal:pty-1', 'detached-terminal-1');
		expect(hasPendingReclaimNudge('terminal:pty-1')).toBe(false);

		await reclaimSurface('terminal:pty-1');

		expect(hasPendingReclaimNudge('terminal:pty-1')).toBe(true);
	});

	it('does NOT arm the nudge for a non-terminal (chat/viewer) reclaim', async () => {
		markSurfaceDetached('chat:thread-a', 'detached-chat-1');

		await reclaimSurface('chat:thread-a');

		// Nothing would ever clear it — must never be armed in the first place.
		expect(hasPendingReclaimNudge('chat:thread-a')).toBe(false);
	});

	it('undoes the optimistic arm when the window close fails', async () => {
		markSurfaceDetached('terminal:pty-1', 'detached-terminal-1');
		mockCloseWindow.mockRejectedValue(new Error('close failed'));
		mockListWindows.mockResolvedValue([
			// The window is still open — the close genuinely didn't happen.
			descriptor('detached-terminal-1', ['terminal:pty-1']),
		]);

		await reclaimSurface('terminal:pty-1');

		// A future genuine reclaim, not this failed one, must be what arms it.
		expect(hasPendingReclaimNudge('terminal:pty-1')).toBe(false);
	});

	it('arms a terminal surface reclaimed via OS titlebar close (sync map-diff)', async () => {
		// Both were detached; the terminal window is closed via the OS chrome so
		// only the map-diff in syncDetachedSurfaces sees the transition.
		markSurfaceDetached('terminal:pty-9', 'detached-terminal-1');
		markSurfaceDetached('chat:thread-a', 'detached-chat-1');
		mockListWindows.mockResolvedValue([
			// terminal window gone; chat window still open.
			descriptor('detached-chat-1', ['chat:thread-a']),
		]);

		await syncDetachedSurfaces();

		expect(hasPendingReclaimNudge('terminal:pty-9')).toBe(true);
		expect(isDetached('terminal:pty-9')).toBe(false);
	});

	it('does NOT arm a non-terminal surface closed via the OS titlebar', async () => {
		markSurfaceDetached('chat:thread-a', 'detached-chat-1');
		mockListWindows.mockResolvedValue([]);

		await syncDetachedSurfaces();

		expect(hasPendingReclaimNudge('chat:thread-a')).toBe(false);
	});

	it('clearPendingReclaimNudge is idempotent — a double-clear is safe', () => {
		markSurfaceDetached('terminal:pty-1', 'detached-terminal-1');
		return reclaimSurface('terminal:pty-1').then(() => {
			expect(hasPendingReclaimNudge('terminal:pty-1')).toBe(true);
			clearPendingReclaimNudge('terminal:pty-1');
			expect(hasPendingReclaimNudge('terminal:pty-1')).toBe(false);
			// Second clear must not throw and must leave it cleared — this is the
			// StrictMode double-invoke path the consumer relies on.
			clearPendingReclaimNudge('terminal:pty-1');
			expect(hasPendingReclaimNudge('terminal:pty-1')).toBe(false);
		});
	});
});
