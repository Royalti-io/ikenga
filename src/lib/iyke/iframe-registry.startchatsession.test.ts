// Tests the first-party artifact channel for host.startChatSession added to
// the iyke iframe message listener (WP-19 / 04 Round 6). Proves the
// request/response wiring: a {kind:'host.startChatSession'} message runs the
// shared confirm+seed helper and posts a :result back keyed by request_id;
// a missing prompt responds with an error without invoking the helper.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/pkg/start-seeded-chat-confirmed', () => ({
	startSeededChatWithConfirm: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import { installIykeIframeMessageListener } from './iframe-registry';
import { startSeededChatWithConfirm } from '@/components/pkg/start-seeded-chat-confirmed';

const seedConfirm = vi.mocked(startSeededChatWithConfirm);

function postFromIframe(payload: unknown, requestId = 'req-1') {
	const source = { postMessage: vi.fn() } as unknown as Window;
	window.dispatchEvent(
		new MessageEvent('message', {
			data: { __iyke: true, kind: 'host.startChatSession', request_id: requestId, payload },
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

describe('artifact host.startChatSession channel', () => {
	it('runs the confirm+seed helper and posts the result back, keyed by request_id', async () => {
		seedConfirm.mockResolvedValue({ ok: true, threadId: 'thread-9', paneId: 'pane-9' });

		const source = postFromIframe(
			{ prompt: 'Build the WP-09 brief', title: 'WP-09', split: 'right' },
			'req-42'
		);

		// Helper is invoked with the parsed opts and a first-party requester label.
		expect(seedConfirm).toHaveBeenCalledWith('this artifact', {
			prompt: 'Build the WP-09 brief',
			projectId: undefined,
			title: 'WP-09',
			engineId: undefined,
			split: 'right',
		});

		// Result posts back after the helper resolves.
		await vi.waitFor(() => expect(source.postMessage).toHaveBeenCalled());
		expect(source.postMessage).toHaveBeenCalledWith(
			{
				__iyke: true,
				kind: 'host.startChatSession:result',
				request_id: 'req-42',
				payload: { ok: true, threadId: 'thread-9', paneId: 'pane-9' },
			},
			'*'
		);
	});

	it('responds with an error and skips the helper when prompt is missing', () => {
		const source = postFromIframe({ title: 'no prompt' }, 'req-7');

		expect(seedConfirm).not.toHaveBeenCalled();
		expect(source.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: 'host.startChatSession:result',
				request_id: 'req-7',
				payload: { ok: false, error: 'missing prompt' },
			}),
			'*'
		);
	});

	it('passes a declined result straight through', async () => {
		seedConfirm.mockResolvedValue({ ok: false, declined: true });

		const source = postFromIframe({ prompt: 'x' }, 'req-3');

		await vi.waitFor(() => expect(source.postMessage).toHaveBeenCalled());
		expect(source.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({ payload: { ok: false, declined: true } }),
			'*'
		);
	});
});
