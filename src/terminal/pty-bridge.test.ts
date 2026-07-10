import { beforeEach, describe, expect, it, vi } from 'vitest';

// Capture the onData callback the Pty class hands to `ptyListen` so we can
// drive bytes from the test. `ptySpawn` returns a synthetic id; `ptyKill` is a
// no-op. `ptyScrollback` returns a promise the test resolves by hand so we can
// interleave live bytes with the snapshot the way a real detached attach does.
let deliver: ((bytes: Uint8Array, endOffset: number) => void) | null = null;
let scrollbackResolve: ((v: { data: Uint8Array; endOffset: number } | null) => void) | null = null;

vi.mock('../lib/tauri-cmd', () => ({
	ptySpawn: vi.fn(async () => 'fake-id'),
	ptyListen: vi.fn(async (_id: string, onData: (bytes: Uint8Array, endOffset: number) => void) => {
		deliver = onData;
		return () => undefined;
	}),
	ptyScrollback: vi.fn(
		() =>
			new Promise((resolve) => {
				scrollbackResolve = resolve;
			})
	),
	ptyKill: vi.fn(async () => undefined),
	ptyResize: vi.fn(async () => undefined),
	ptyWrite: vi.fn(async () => undefined),
}));

import { Pty } from './pty-bridge';

function bytes(s: string): Uint8Array {
	return new TextEncoder().encode(s);
}

/** Drain microtasks + one macrotask so an in-flight `Pty.attach` progresses
 *  past its `await`s (listener registration, scrollback fetch). */
function flush(): Promise<void> {
	return new Promise((r) => setTimeout(r, 0));
}

// Running byte offset for the spawn-mode tests, which don't care about the
// exact value (dedup never engages) but must still supply a monotonic one.
let total = 0;
function emit(s: string) {
	const b = bytes(s);
	total += b.length;
	deliver!(b, total);
}

beforeEach(() => {
	deliver = null;
	scrollbackResolve = null;
	total = 0;
});

describe('Pty replay buffer', () => {
	it('replays pre-subscriber bytes to the first subscriber, then drains', async () => {
		const pty = await Pty.spawn({ cwd: '/', cmd: ['bash'] });
		emit('hello ');
		emit('world');

		const seen: string[] = [];
		const off = pty.onData((b) => seen.push(new TextDecoder().decode(b)));
		expect(seen.join('')).toBe('hello world');
		off();
	});

	it('does NOT re-replay drained bytes to a late subscriber', async () => {
		const pty = await Pty.spawn({ cwd: '/', cmd: ['bash'] });
		emit('early');

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
		emit('A');
		expect(first.join('')).toBe('A');

		// Yield (Studio attach handoff). Bytes during the gap should buffer.
		off1();
		emit('B');
		emit('C');

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
		emit('x');
		emit('y');
		expect(seen.join('')).toBe('xy');
		off();
	});
});

describe('Pty detached-attach scrollback replay', () => {
	it('replays the scrollback snapshot before live output when no live bytes raced', async () => {
		const p = Pty.attach('fake-id', 'x');
		await flush(); // registers the live listener, then awaits scrollback
		// Origin had emitted 'hello ' (offsets 0..6) before we attached.
		scrollbackResolve!({ data: bytes('hello '), endOffset: 6 });
		const pty = await p;

		const seen: string[] = [];
		const off = pty.onData((b) => seen.push(new TextDecoder().decode(b)));
		expect(seen.join('')).toBe('hello ');

		// Live output continues from where the snapshot ended.
		deliver!(bytes('world'), 11);
		expect(seen.join('')).toBe('hello world');
		off();
	});

	it('trims the overlap when a live chunk re-covers snapshot bytes (dedupUpTo)', async () => {
		const p = Pty.attach('fake-id', 'x');
		await flush();
		scrollbackResolve!({ data: bytes('hello '), endOffset: 6 });
		const pty = await p;

		const seen: string[] = [];
		const off = pty.onData((b) => seen.push(new TextDecoder().decode(b)));
		expect(seen.join('')).toBe('hello ');

		// A live chunk starting at offset 4 re-covers 'o ' then adds 'world'.
		// The 'o ' prefix must be dropped, not double-printed.
		deliver!(bytes('o world'), 11);
		expect(seen.join('')).toBe('hello world');
		off();
	});

	it('drops the overlap when live bytes arrive before the snapshot resolves', async () => {
		const p = Pty.attach('fake-id', 'x');
		await flush();
		// Live tail 'wor' (offsets 6..9) buffers during the attach handshake.
		deliver!(bytes('wor'), 9);
		// Snapshot then arrives covering the whole stream so far (0..9).
		scrollbackResolve!({ data: bytes('hello wor'), endOffset: 9 });
		const pty = await p;

		const seen: string[] = [];
		const off = pty.onData((b) => seen.push(new TextDecoder().decode(b)));
		// 'wor' must appear once — snapshot prefix 'hello ' + buffered 'wor'.
		expect(seen.join('')).toBe('hello wor');

		deliver!(bytes('ld'), 11);
		expect(seen.join('')).toBe('hello world');
		off();
	});

	it('tolerates a missing snapshot (exited PTY) and still streams live bytes', async () => {
		const p = Pty.attach('fake-id', 'x');
		await flush();
		scrollbackResolve!(null);
		const pty = await p;

		const seen: string[] = [];
		const off = pty.onData((b) => seen.push(new TextDecoder().decode(b)));
		deliver!(bytes('live'), 4);
		expect(seen.join('')).toBe('live');
		off();
	});
});
