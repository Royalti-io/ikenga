// Verb-level tests for host.sendToActiveSession (WP-22 / G-ACTIVE-SESSION).
//
// Proves the gate's sign-off check deterministically:
//   - ok: a pkg with the engine:invoke scope and an active chat pane gets
//     an `{ ok: true, threadId }` payload; the shared core was invoked
//     with the verb's prompt + source.
//   - no-active-session: scope granted but the focused pane isn't a chat
//     pane → `{ ok: false, reason: 'no-active-session' }`.
//   - scope-denied: pkg lacks `engine:invoke` → `{ ok: false, reason:
//     'scope-denied' }`. Core is never called.
//   - missing-prompt: argument validation fires before any scope work.
//
// The shared core (`sendToActiveSession`) is mocked here — its own
// coverage (source-stamp, focused-pane resolver, adapter dispatch) lives
// in `send-to-active-session.test.ts`. This file's job is to prove the
// verb wiring: scope-gate → core → structured payload.

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
	supabaseConfigGet: vi.fn(),
}));

vi.mock('@/components/pkg/send-to-active-session', () => ({
	sendToActiveSession: vi.fn(),
}));

import { sendToActiveSession } from '@/components/pkg/send-to-active-session';
import { pkgKernelStatus, pkgPreviewManifest } from '@/lib/tauri-cmd';
import { dispatchHostCall } from './pkg-iframe-host';

const kernelStatus = vi.mocked(pkgKernelStatus);
const previewManifest = vi.mocked(pkgPreviewManifest);
const sendCore = vi.mocked(sendToActiveSession);

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

describe('host.sendToActiveSession', () => {
	it('dispatches to the active session when the pkg has engine:invoke', async () => {
		withScope(true);
		sendCore.mockResolvedValue({ ok: true, threadId: 'thread-9' });

		const res = await dispatchHostCall(PKG, 'host.sendToActiveSession', {
			prompt: 'refresh the board',
			source: 'board',
		});

		// Core gets the verb args verbatim — source-stamping happens inside.
		expect(sendCore).toHaveBeenCalledWith({
			prompt: 'refresh the board',
			source: 'board',
		});
		expect(res.isError).toBeUndefined();
		expect(res.structuredContent).toMatchObject({
			ok: true,
			threadId: 'thread-9',
		});
	});

	it("returns reason='scope-denied' when the pkg lacks engine:invoke", async () => {
		withScope(false);

		const res = await dispatchHostCall(PKG, 'host.sendToActiveSession', {
			prompt: 'refresh the board',
		});

		expect(res.isError).toBe(true);
		expect(res.structuredContent).toMatchObject({
			ok: false,
			reason: 'scope-denied',
		});
		// Core never invoked when scope is denied — the gate short-circuits.
		expect(sendCore).not.toHaveBeenCalled();
	});

	it("returns reason='no-active-session' when scope passes but no chat pane is focused", async () => {
		withScope(true);
		sendCore.mockResolvedValue({ ok: false, reason: 'no-active-session' });

		const res = await dispatchHostCall(PKG, 'host.sendToActiveSession', {
			prompt: 'status check',
			source: 'palette',
		});

		expect(res.isError).toBe(true);
		expect(res.structuredContent).toMatchObject({
			ok: false,
			reason: 'no-active-session',
		});
	});

	it('errors on a missing prompt before any scope check', async () => {
		const res = await dispatchHostCall(PKG, 'host.sendToActiveSession', {});

		expect(res.isError).toBe(true);
		expect(res.content[0]?.text).toContain('missing required `prompt`');
		expect(kernelStatus).not.toHaveBeenCalled();
		expect(sendCore).not.toHaveBeenCalled();
	});
});
