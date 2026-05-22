// Verb-level tests for host.openSessionDialog (WP-27 / G-SESSION-DIALOG).
//
// Covers the pkg-iframe path: scope gate, ok-chat, ok-terminal, cancelled,
// scope-denied. The dialog itself is mocked at the `openSessionDialog` API
// boundary — full pre-fill behaviour is exercised in open-session-dialog.test.ts
// (the core test) and the workspace-mounted host wires the args verbatim, so
// this layer only needs to prove the dispatcher hands args through and surfaces
// the frozen result envelope.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/tauri-cmd', () => ({
	pkgKernelStatus: vi.fn(),
	pkgPreviewManifest: vi.fn(),
	pkgContentHtml: vi.fn(),
	pkgContentRevoke: vi.fn(),
	pkgMcpCall: vi.fn(),
	pkgSidecarCall: vi.fn(),
	supabaseConfigGet: vi.fn(),
}));

vi.mock('@/components/pkg/start-seeded-chat-confirmed', () => ({
	startSeededChatWithConfirm: vi.fn(),
}));

vi.mock('@/components/pkg/open-session-dialog', async () => {
	const actual = await vi.importActual<
		typeof import('@/components/pkg/open-session-dialog')
	>('@/components/pkg/open-session-dialog');
	return {
		...actual,
		openSessionDialog: vi.fn(),
	};
});

import { pkgKernelStatus, pkgPreviewManifest } from '@/lib/tauri-cmd';
import { openSessionDialog } from '@/components/pkg/open-session-dialog';
import { dispatchHostCall } from './pkg-iframe-host';

const kernelStatus = vi.mocked(pkgKernelStatus);
const previewManifest = vi.mocked(pkgPreviewManifest);
const opener = vi.mocked(openSessionDialog);

const PKG = 'com.example.board';

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

beforeEach(() => {
	vi.clearAllMocks();
});

describe('host.openSessionDialog (pkg-iframe path)', () => {
	it('opens the dialog with pre-filled args and returns the chat result', async () => {
		withScope(true);
		opener.mockResolvedValue({ ok: true, kind: 'chat', threadId: 'thread-9' });

		const res = await dispatchHostCall(PKG, 'host.openSessionDialog', {
			initialPrompt: 'Build the WP-09 brief',
			engineId: 'com.ikenga.engine-claude-code',
			sessionKind: 'chat',
			cwd: '/tmp/proj',
			title: 'WP-09',
			source: 'board',
		});

		expect(opener).toHaveBeenCalledWith({
			initialPrompt: 'Build the WP-09 brief',
			engineId: 'com.ikenga.engine-claude-code',
			sessionKind: 'chat',
			cwd: '/tmp/proj',
			title: 'WP-09',
			source: 'board',
		});
		expect(res.isError).toBeUndefined();
		expect(res.structuredContent).toEqual({ ok: true, kind: 'chat', threadId: 'thread-9' });
	});

	it('returns the terminal result verbatim', async () => {
		withScope(true);
		opener.mockResolvedValue({ ok: true, kind: 'terminal', paneId: 'pane-3' });

		const res = await dispatchHostCall(PKG, 'host.openSessionDialog', {
			initialPrompt: 'pwd',
			sessionKind: 'terminal',
		});

		expect(res.structuredContent).toEqual({ ok: true, kind: 'terminal', paneId: 'pane-3' });
	});

	it('returns cancelled when the user dismisses the dialog', async () => {
		withScope(true);
		opener.mockResolvedValue({ ok: false, reason: 'cancelled' });

		const res = await dispatchHostCall(PKG, 'host.openSessionDialog', {
			initialPrompt: 'never sent',
		});

		expect(res.structuredContent).toEqual({ ok: false, reason: 'cancelled' });
	});

	it('returns scope-denied without opening the dialog when the pkg lacks engine:invoke', async () => {
		withScope(false);

		const res = await dispatchHostCall(PKG, 'host.openSessionDialog', {
			initialPrompt: 'x',
		});

		expect(res.isError).toBe(true);
		expect(res.structuredContent).toEqual({ ok: false, reason: 'scope-denied' });
		expect(opener).not.toHaveBeenCalled();
	});

	it('drops junk values for typed args (sessionKind, types coerced to undefined)', async () => {
		withScope(true);
		opener.mockResolvedValue({ ok: true, kind: 'chat', threadId: 't' });

		await dispatchHostCall(PKG, 'host.openSessionDialog', {
			initialPrompt: 'x',
			sessionKind: 'sideways', // not 'chat' | 'terminal'
			engineId: 42, // not a string
			cwd: null,
		});

		expect(opener).toHaveBeenCalledWith({
			initialPrompt: 'x',
			engineId: undefined,
			sessionKind: undefined,
			cwd: undefined,
			title: undefined,
			source: undefined,
		});
	});
});
