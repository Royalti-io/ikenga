// Tests the first-party artifact channel for host.sendToActiveSession
// added to the iyke iframe message listener (WP-22 / G-ACTIVE-SESSION).
//
// Mirrors the startChatSession channel test (iframe-registry.startchatsession.test.ts)
// but covers the attach-to-existing-thread shape instead of the mint-fresh
// shape. Artifacts are first-party so they skip the pkg engine:invoke
// scope check (Round-6 Opt-A); the core handles the focused-pane
// resolution, source-stamp, and dispatch.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/pkg/send-to-active-session', () => ({
	sendToActiveSession: vi.fn(),
}));
vi.mock('@/components/pkg/start-seeded-chat-confirmed', () => ({
	startSeededChatWithConfirm: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import { sendToActiveSession } from '@/components/pkg/send-to-active-session';
import { installIykeIframeMessageListener } from './iframe-registry';

const sendCore = vi.mocked(sendToActiveSession);

function postFromIframe(payload: unknown, requestId = 'req-1') {
	const source = { postMessage: vi.fn() } as unknown as Window;
	window.dispatchEvent(
		new MessageEvent('message', {
			data: { __iyke: true, kind: 'host.sendToActiveSession', request_id: requestId, payload },
			source,
		})
	);
	return source as unknown as { postMessage: ReturnType<typeof vi.fn> };
}

beforeEach(() => {
	vi.clearAllMocks();
	// Idempotent — only the first call installs the singleton listener.
	installIykeIframeMessageListener();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('artifact host.sendToActiveSession channel', () => {
	it('invokes the core and posts the result back, keyed by request_id', async () => {
		sendCore.mockResolvedValue({ ok: true, threadId: 'thread-77' });

		const source = postFromIframe(
			{ prompt: 'refresh the board', source: 'board' },
			'req-42'
		);

		// Core is invoked with the verb's prompt + source — no scope check
		// on this surface (first-party artifact channel).
		expect(sendCore).toHaveBeenCalledWith({
			prompt: 'refresh the board',
			source: 'board',
		});

		// Result posts back after the core resolves.
		await vi.waitFor(() => expect(source.postMessage).toHaveBeenCalled());
		expect(source.postMessage).toHaveBeenCalledWith(
			{
				__iyke: true,
				kind: 'host.sendToActiveSession:result',
				request_id: 'req-42',
				payload: { ok: true, threadId: 'thread-77' },
			},
			'*'
		);
	});

	it('responds with an error and skips the core when prompt is missing', () => {
		const source = postFromIframe({ source: 'palette' }, 'req-7');

		expect(sendCore).not.toHaveBeenCalled();
		expect(source.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: 'host.sendToActiveSession:result',
				request_id: 'req-7',
				payload: { ok: false, error: 'missing prompt' },
			}),
			'*'
		);
	});

	it("passes a no-active-session refusal straight through to the artifact", async () => {
		sendCore.mockResolvedValue({ ok: false, reason: 'no-active-session' });

		const source = postFromIframe({ prompt: 'status', source: 'palette' }, 'req-3');

		await vi.waitFor(() => expect(source.postMessage).toHaveBeenCalled());
		expect(source.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				payload: { ok: false, reason: 'no-active-session' },
			}),
			'*'
		);
	});
});
