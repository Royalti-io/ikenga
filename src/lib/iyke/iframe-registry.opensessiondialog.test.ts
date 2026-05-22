// Artifact-channel tests for host.openSessionDialog (WP-27 / G-SESSION-DIALOG).
//
// A {kind:'host.openSessionDialog'} message runs the openSessionDialog API
// (which the dialog will eventually resolve) and posts a :result back keyed
// by request_id. First-party — no scope check at this layer; the pkg verb
// path from pkg-iframe-host.tsx is where the engine:invoke gate lives.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/pkg/open-session-dialog', async () => {
	const actual = await vi.importActual<
		typeof import('@/components/pkg/open-session-dialog')
	>('@/components/pkg/open-session-dialog');
	return {
		...actual,
		openSessionDialog: vi.fn(),
	};
});
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import { installIykeIframeMessageListener } from './iframe-registry';
import { openSessionDialog } from '@/components/pkg/open-session-dialog';

const opener = vi.mocked(openSessionDialog);

function postFromIframe(payload: unknown, requestId = 'req-1') {
	const source = { postMessage: vi.fn() } as unknown as Window;
	window.dispatchEvent(
		new MessageEvent('message', {
			data: {
				__iyke: true,
				kind: 'host.openSessionDialog',
				request_id: requestId,
				payload,
			},
			source,
		})
	);
	return source as unknown as { postMessage: ReturnType<typeof vi.fn> };
}

beforeEach(() => {
	vi.clearAllMocks();
	// Idempotent — only the first install attaches the singleton listener.
	installIykeIframeMessageListener();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('artifact host.openSessionDialog channel', () => {
	it('routes the args through openSessionDialog and posts the chat result back keyed by request_id', async () => {
		opener.mockResolvedValue({ ok: true, kind: 'chat', threadId: 'thread-9' });

		const source = postFromIframe(
			{
				initialPrompt: 'Build the WP-09 brief',
				engineId: 'com.ikenga.engine-claude-code',
				sessionKind: 'chat',
				cwd: '/tmp/proj',
				source: 'board',
			},
			'req-42'
		);

		expect(opener).toHaveBeenCalledWith({
			initialPrompt: 'Build the WP-09 brief',
			engineId: 'com.ikenga.engine-claude-code',
			sessionKind: 'chat',
			cwd: '/tmp/proj',
			title: undefined,
			source: 'board',
		});

		await vi.waitFor(() => expect(source.postMessage).toHaveBeenCalled());
		expect(source.postMessage).toHaveBeenCalledWith(
			{
				__iyke: true,
				kind: 'host.openSessionDialog:result',
				request_id: 'req-42',
				payload: { ok: true, kind: 'chat', threadId: 'thread-9' },
			},
			'*'
		);
	});

	it('passes a terminal result straight through', async () => {
		opener.mockResolvedValue({ ok: true, kind: 'terminal', paneId: 'pane-3' });

		const source = postFromIframe(
			{ initialPrompt: 'pwd', sessionKind: 'terminal' },
			'req-2'
		);

		await vi.waitFor(() => expect(source.postMessage).toHaveBeenCalled());
		expect(source.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: 'host.openSessionDialog:result',
				request_id: 'req-2',
				payload: { ok: true, kind: 'terminal', paneId: 'pane-3' },
			}),
			'*'
		);
	});

	it('passes a cancelled result straight through', async () => {
		opener.mockResolvedValue({ ok: false, reason: 'cancelled' });

		const source = postFromIframe({ initialPrompt: 'x' }, 'req-3');

		await vi.waitFor(() => expect(source.postMessage).toHaveBeenCalled());
		expect(source.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				payload: { ok: false, reason: 'cancelled' },
			}),
			'*'
		);
	});

	it('drops junk values for typed args (sessionKind, engineId, cwd coerce to undefined)', async () => {
		opener.mockResolvedValue({ ok: false, reason: 'cancelled' });

		postFromIframe(
			{
				initialPrompt: 'x',
				sessionKind: 'sideways',
				engineId: 42,
				cwd: null,
			},
			'req-4'
		);

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
