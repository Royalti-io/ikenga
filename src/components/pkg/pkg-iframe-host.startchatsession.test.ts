// Verb-level tests for host.startChatSession (WP-10 / G-ACTION-CHANNEL).
//
// Proves the gate's sign-off check deterministically: a pkg with the
// engine:invoke scope succeeds (after confirm); a pkg without it declines
// cleanly. Also covers missing-prompt, user-cancel, and uninstalled-pkg
// (fail-closed) paths, plus split arg parsing.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/tauri-cmd', () => ({
	pkgKernelStatus: vi.fn(),
	pkgPreviewManifest: vi.fn(),
	// Referenced by the host module's other verbs / component; unused here
	// but must exist so the named imports resolve.
	pkgContentHtml: vi.fn(),
	pkgContentRevoke: vi.fn(),
	pkgMcpCall: vi.fn(),
	pkgSidecarCall: vi.fn(),
	// Pulled in transitively by host-context → supabase at module load.
	supabaseConfigGet: vi.fn(),
}));

vi.mock('@/shell/artifact-wizard/scaffold', () => ({
	startSeededChat: vi.fn(),
}));

vi.mock('@/components/pkg/seed-chat-confirm-store', () => ({
	useSeedChatConfirmStore: { getState: vi.fn() },
}));

import { useSeedChatConfirmStore } from '@/components/pkg/seed-chat-confirm-store';
import { pkgKernelStatus, pkgPreviewManifest } from '@/lib/tauri-cmd';
import { startSeededChat } from '@/shell/artifact-wizard/scaffold';
import { dispatchHostCall } from './pkg-iframe-host';

const kernelStatus = vi.mocked(pkgKernelStatus);
const previewManifest = vi.mocked(pkgPreviewManifest);
const seededChat = vi.mocked(startSeededChat);
const confirmGetState = vi.mocked(useSeedChatConfirmStore.getState);

const PKG = 'com.example.board';

/** Make the scope check resolve to `granted` for PKG. */
function withScope(granted: boolean) {
	kernelStatus.mockResolvedValue({
		installed: [{ id: PKG, install_path: `/pkgs/${PKG}` }],
		registries: {},
		api_version: 1,
	} as never);
	previewManifest.mockResolvedValue({
		id: PKG,
		name: PKG,
		version: '1.0.0',
		ikenga_api: '1',
		permissions: granted ? { engine: ['invoke'] } : { fs: ['read'] },
	} as never);
}

/** Make the confirm modal resolve to `approved`. */
function withConfirm(approved: boolean) {
	const request = vi.fn().mockResolvedValue(approved);
	confirmGetState.mockReturnValue({ request } as never);
	return request;
}

beforeEach(() => {
	vi.clearAllMocks();
	seededChat.mockResolvedValue({ threadId: 'thread-1', paneId: 'pane-1' });
});

describe('host.startChatSession', () => {
	it('starts a session when the pkg has engine:invoke and the user approves', async () => {
		withScope(true);
		const request = withConfirm(true);

		const res = await dispatchHostCall(PKG, 'host.startChatSession', {
			prompt: 'Build the WP-09 brief',
			projectId: 'ikenga',
			title: 'WP-09',
			split: 'right',
		});

		expect(request).toHaveBeenCalledWith({
			pkgId: PKG,
			prompt: 'Build the WP-09 brief',
			title: 'WP-09',
		});
		expect(seededChat).toHaveBeenCalledWith({
			prompt: 'Build the WP-09 brief',
			projectId: 'ikenga',
			title: 'WP-09',
			engineId: undefined,
			split: 'right',
		});
		expect(res.isError).toBeUndefined();
		expect(res.structuredContent).toMatchObject({
			ok: true,
			threadId: 'thread-1',
			paneId: 'pane-1',
		});
	});

	it('declines cleanly when the pkg lacks engine:invoke', async () => {
		withScope(false);
		const request = withConfirm(true);

		const res = await dispatchHostCall(PKG, 'host.startChatSession', {
			prompt: 'Build the WP-09 brief',
		});

		expect(res.isError).toBe(true);
		expect(res.content[0]?.text).toContain('engine:invoke');
		// Never reaches the confirm or the seam.
		expect(request).not.toHaveBeenCalled();
		expect(seededChat).not.toHaveBeenCalled();
	});

	it('fails closed when the calling pkg is not installed', async () => {
		kernelStatus.mockResolvedValue({
			installed: [],
			registries: {},
			api_version: 1,
		} as never);
		const request = withConfirm(true);

		const res = await dispatchHostCall(PKG, 'host.startChatSession', { prompt: 'x' });

		expect(res.isError).toBe(true);
		expect(seededChat).not.toHaveBeenCalled();
		expect(request).not.toHaveBeenCalled();
	});

	it('errors on a missing prompt before any scope check', async () => {
		const res = await dispatchHostCall(PKG, 'host.startChatSession', {});

		expect(res.isError).toBe(true);
		expect(res.content[0]?.text).toContain('missing required `prompt`');
		expect(kernelStatus).not.toHaveBeenCalled();
		expect(seededChat).not.toHaveBeenCalled();
	});

	it('does not send when the user cancels the confirm', async () => {
		withScope(true);
		withConfirm(false);

		const res = await dispatchHostCall(PKG, 'host.startChatSession', {
			prompt: 'Build the WP-09 brief',
		});

		expect(res.structuredContent).toMatchObject({ ok: false, declined: true });
		expect(seededChat).not.toHaveBeenCalled();
	});

	it('passes split through only for valid values (else undefined)', async () => {
		withScope(true);
		withConfirm(true);

		await dispatchHostCall(PKG, 'host.startChatSession', { prompt: 'x', split: 'sideways' });

		expect(seededChat).toHaveBeenCalledWith(
			expect.objectContaining({ prompt: 'x', split: undefined })
		);
	});
});
