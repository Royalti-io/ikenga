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

beforeEach(() => {
	useDetachedSurfaces.setState({ surfaceToWindow: {} });
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
