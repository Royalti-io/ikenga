// Module-level per-session ring buffer of PTY output bytes. Independent
// of xterm.js — captures everything the PTY emits so iyke can read it
// even when the pane isn't visible or xterm's canvas can't be screen-
// shotted (xterm.js canvas content isn't reliably composited into
// WebKitGTK snapshots). Capped per session to avoid unbounded growth.
//
// Lifecycle: `attachCapture(sessionId, pty)` is called once after
// `Pty.spawn()` resolves (in `single-terminal.tsx`); the returned
// unsubscribe is invoked from `disposePty()` in `pty-registry.ts`.

import type { Pty } from './pty-bridge';

const DEFAULT_CAP_BYTES = 256 * 1024; // 256 KiB per session

interface SessionBuffer {
	bytes: Uint8Array;
	capBytes: number;
	/**
	 * Absolute stream offset of the last captured byte — i.e. the cumulative
	 * count of bytes the PTY has emitted, mirrored from `Pty.streamOffset` on
	 * every append. Because it comes from the Pty (not a local tally) it stays
	 * correct even if the capture subscribed after the stream had already
	 * emitted bytes. The captured window's absolute start is
	 * `endOffset - bytes.length`. Lets a ring replay be reconciled against the
	 * live stream by offset (drop the overlap) instead of double-painting it.
	 */
	endOffset: number;
	unsubscribe: () => void;
}

const buffers = new Map<string, SessionBuffer>();

function appendCapped(buf: SessionBuffer, chunk: Uint8Array): void {
	if (chunk.length === 0) return;
	const cap = buf.capBytes;
	const cur = buf.bytes;
	if (chunk.length >= cap) {
		// Single write larger than cap — keep only the tail.
		buf.bytes = chunk.slice(chunk.length - cap);
		return;
	}
	const combined = cur.length + chunk.length;
	if (combined <= cap) {
		const next = new Uint8Array(combined);
		next.set(cur, 0);
		next.set(chunk, cur.length);
		buf.bytes = next;
		return;
	}
	// Drop the oldest (combined - cap) bytes from cur, then append chunk.
	const drop = combined - cap;
	const next = new Uint8Array(cap);
	next.set(cur.subarray(drop), 0);
	next.set(chunk, cur.length - drop);
	buf.bytes = next;
}

export function attachCapture(
	sessionId: string,
	pty: Pty,
	opts?: { capBytes?: number }
): () => void {
	// Don't double-attach. Reuse existing buffer's unsubscribe.
	const existing = buffers.get(sessionId);
	if (existing) return existing.unsubscribe;

	const buf: SessionBuffer = {
		bytes: new Uint8Array(0),
		capBytes: Math.max(4096, opts?.capBytes ?? DEFAULT_CAP_BYTES),
		endOffset: 0,
		unsubscribe: () => {},
	};
	const off = pty.onData((bytes) => {
		appendCapped(buf, bytes);
		// Tag the ring with the PTY's absolute stream offset so a later replay
		// can be offset-reconciled against the live stream at the seam.
		buf.endOffset = pty.streamOffset;
	});
	const unsubscribe = () => {
		off();
		buffers.delete(sessionId);
	};
	buf.unsubscribe = unsubscribe;
	buffers.set(sessionId, buf);
	return unsubscribe;
}

export function detachCapture(sessionId: string): void {
	const buf = buffers.get(sessionId);
	if (buf) buf.unsubscribe();
}

export function readCapture(sessionId: string): Uint8Array | null {
	const buf = buffers.get(sessionId);
	return buf ? buf.bytes : null;
}

/**
 * Like `readCapture`, but also returns the absolute stream offset the ring
 * currently ends at (`Pty.streamOffset` at the last append). Callers that
 * replay the ring into a fresh terminal use `endOffset` to prime
 * `Pty.primeExternalSnapshot`, so the live stream drops the overlap at the
 * seam instead of double-painting the last few bytes. Returns `null` when no
 * capture exists for the session.
 */
export function readCaptureWithOffset(
	sessionId: string
): { data: Uint8Array; endOffset: number } | null {
	const buf = buffers.get(sessionId);
	return buf ? { data: buf.bytes, endOffset: buf.endOffset } : null;
}

export function listCaptureSessions(): string[] {
	return Array.from(buffers.keys());
}

// Strip a conservative subset of ANSI/VT escapes that show up in
// interactive TUIs. Not a perfect terminal emulator — just enough to
// turn the captured byte stream into readable text for an agent.
// Recognised:
//   CSI (`\x1b[…[@-~]`) — colors, cursor moves, erase
//   OSC (`\x1b]…(BEL|ST)`) — title, hyperlinks
//   SS3 (`\x1bO?`) — function keys
//   Single-char ESC sequences (`\x1b[=@-Z\\\\-_]`)
//   Other C0 control chars except \n, \r, \t — dropped
export function stripAnsi(input: string): string {
	let out = '';
	let i = 0;
	while (i < input.length) {
		const c = input.charCodeAt(i);
		if (c === 0x1b) {
			i++;
			if (i >= input.length) break;
			const next = input[i];
			if (next === '[') {
				// CSI: params then final byte in 0x40..0x7e
				i++;
				while (i < input.length) {
					const code = input.charCodeAt(i);
					i++;
					if (code >= 0x40 && code <= 0x7e) break;
				}
			} else if (next === ']') {
				// OSC: terminated by BEL (0x07) or ST (ESC \)
				i++;
				while (i < input.length) {
					const code = input.charCodeAt(i);
					if (code === 0x07) {
						i++;
						break;
					}
					if (code === 0x1b && input[i + 1] === '\\') {
						i += 2;
						break;
					}
					i++;
				}
			} else if (next === 'P' || next === 'X' || next === '^' || next === '_') {
				// DCS/SOS/PM/APC: terminated by ST
				i++;
				while (i < input.length) {
					if (input.charCodeAt(i) === 0x1b && input[i + 1] === '\\') {
						i += 2;
						break;
					}
					i++;
				}
			} else {
				// Two-char ESC X — drop both
				i++;
			}
			continue;
		}
		// Pass newline/tab/CR through; drop other C0 controls.
		if (c === 0x09 || c === 0x0a || c === 0x0d || c >= 0x20) {
			out += input[i];
		}
		i++;
	}
	return out;
}
