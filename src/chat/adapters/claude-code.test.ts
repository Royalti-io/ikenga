// Regression tests for ClaudeCodeAdapter.attach().
//
// The bug: attach() is called concurrently (a thread's mount hook + send(),
// fired near-simultaneously by the seeded-chat path). The dedupe guard checks
// `streams.has(threadId)`, but the entry used to be inserted only AFTER an
// `await chatNewSession(...)`. Two racing callers both passed the guard and
// each called `chatListen` → two live listeners on `chat://session/{id}` →
// every SessionUpdate delivered twice (doubled assistant text, duplicate
// tool-call cards). The fix claims the map slot synchronously before any await.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/tauri-cmd', () => ({
	chatCancel: vi.fn(),
	chatListen: vi.fn(),
	chatNewSession: vi.fn(),
	chatPrompt: vi.fn(),
	claudeListSessions: vi.fn(),
}));

vi.mock('@/lib/shell/active-project-cwd', () => ({
	activeProjectCwd: vi.fn(() => '/tmp'),
}));

import { chatListen, chatNewSession } from '@/lib/tauri-cmd';
import { getClaudeCodeAdapterInstance } from './claude-code';

const listen = vi.mocked(chatListen);
const newSession = vi.mocked(chatNewSession);
const adapter = getClaudeCodeAdapterInstance();

beforeEach(async () => {
	await adapter.destroy(); // resets streams + sessioned maps
	listen.mockReset();
	newSession.mockReset();
	// chatNewSession resolves async — the await between the guard and the
	// (old) slot insertion is exactly the race window we're guarding.
	newSession.mockResolvedValue({} as never);
	listen.mockResolvedValue(vi.fn());
});

describe('ClaudeCodeAdapter.attach concurrency', () => {
	it('subscribes exactly once when two attaches race the same thread', async () => {
		await Promise.all([
			adapter.attach('thread-1', '/tmp'),
			adapter.attach('thread-1', '/tmp'),
		]);
		expect(listen).toHaveBeenCalledTimes(1);
		expect(newSession).toHaveBeenCalledTimes(1);
	});

	it('is a no-op on a thread already attached', async () => {
		await adapter.attach('thread-1', '/tmp');
		await adapter.attach('thread-1', '/tmp');
		expect(listen).toHaveBeenCalledTimes(1);
	});

	it('releases the slot on failure so a later attach can retry', async () => {
		listen.mockRejectedValueOnce(new Error('boom'));
		await expect(adapter.attach('thread-1', '/tmp')).rejects.toThrow('boom');

		// Slot was released → the retry actually re-subscribes.
		listen.mockResolvedValueOnce(vi.fn());
		await adapter.attach('thread-1', '/tmp');
		expect(listen).toHaveBeenCalledTimes(2);
	});

	it('subscribes per distinct thread', async () => {
		await Promise.all([
			adapter.attach('thread-a', '/tmp'),
			adapter.attach('thread-b', '/tmp'),
		]);
		expect(listen).toHaveBeenCalledTimes(2);
	});
});
