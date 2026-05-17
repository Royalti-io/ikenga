import { beforeEach, describe, expect, it, vi } from 'vitest';

// Capture the onData callback the Pty class hands to `ptyListen` so we can
// drive bytes from the test. `ptySpawn` returns a synthetic id; `ptyKill`
// is a no-op.
let deliver: ((bytes: Uint8Array) => void) | null = null;

vi.mock('../lib/tauri-cmd', () => ({
	ptySpawn: vi.fn(async () => 'fake-id'),
	ptyListen: vi.fn(async (_id: string, onData: (bytes: Uint8Array) => void) => {
		deliver = onData;
		return () => undefined;
	}),
	ptyKill: vi.fn(async () => undefined),
	ptyResize: vi.fn(async () => undefined),
	ptyWrite: vi.fn(async () => undefined),
}));

import { Pty } from './pty-bridge';

function bytes(s: string): Uint8Array {
	return new TextEncoder().encode(s);
}

beforeEach(() => {
	deliver = null;
});

describe('Pty replay buffer', () => {
	it('replays pre-subscriber bytes to the first subscriber, then drains', async () => {
		const pty = await Pty.spawn({ cwd: '/', cmd: ['bash'] });
		deliver!(bytes('hello '));
		deliver!(bytes('world'));

		const seen: string[] = [];
		const off = pty.onData((b) => seen.push(new TextDecoder().decode(b)));
		expect(seen.join('')).toBe('hello world');
		off();
	});

	it('does NOT re-replay drained bytes to a late subscriber', async () => {
		const pty = await Pty.spawn({ cwd: '/', cmd: ['bash'] });
		deliver!(bytes('early'));

		// First subscriber drains the buffer.
		const first: string[] = [];
		const off1 = pty.onData((b) => first.push(new TextDecoder().decode(b)));
		expect(first.join('')).toBe('early');
		off1();

		// Late subscriber attaches with no new bytes in flight — must not see
		// 'early' again.
		const late: string[] = [];
		const off2 = pty.onData((b) => late.push(new TextDecoder().decode(b)));
		expect(late.join('')).toBe('');
		off2();
	});

	it('captures bytes during the subscribe-yield-resubscribe gap exactly once', async () => {
		const pty = await Pty.spawn({ cwd: '/', cmd: ['bash'] });

		// First subscriber sees live bytes.
		const first: string[] = [];
		const off1 = pty.onData((b) => first.push(new TextDecoder().decode(b)));
		deliver!(bytes('A'));
		expect(first.join('')).toBe('A');

		// Yield (Studio attach handoff). Bytes during the gap should buffer.
		off1();
		deliver!(bytes('B'));
		deliver!(bytes('C'));

		// Late subscriber gets BC once, and the buffer drains.
		const late: string[] = [];
		const off2 = pty.onData((b) => late.push(new TextDecoder().decode(b)));
		expect(late.join('')).toBe('BC');

		// Another resubscribe must not see 'BC' again.
		off2();
		const third: string[] = [];
		const off3 = pty.onData((b) => third.push(new TextDecoder().decode(b)));
		expect(third.join('')).toBe('');
		off3();
	});

	it('passes live bytes straight through while a subscriber is attached', async () => {
		const pty = await Pty.spawn({ cwd: '/', cmd: ['bash'] });
		const seen: string[] = [];
		const off = pty.onData((b) => seen.push(new TextDecoder().decode(b)));
		deliver!(bytes('x'));
		deliver!(bytes('y'));
		expect(seen.join('')).toBe('xy');
		off();
	});
});
