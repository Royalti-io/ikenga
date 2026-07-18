/**
 * pty-bridge — typed orchestration around the Rust pty_* commands.
 *
 * Exposes a small `Pty` class that owns the lifecycle of a single PTY:
 *   - subscribes to the data + exit event streams
 *   - fans out events to multiple subscribers (so the same PTY can be
 *     attached/detached from multiple xterm hosts during its life)
 *   - tracks exit state so late-attaching hosts get the right status
 */

import {
	ptyKill,
	ptyListen,
	ptyResize,
	ptyScrollback,
	ptySpawn,
	ptyWrite,
	type PtySpawnOpts as RawPtySpawnOpts,
} from '../lib/tauri-cmd';

export interface PtySpawnOpts extends RawPtySpawnOpts {
	/** Human-readable label, e.g. `bash -l`. Used for status messages. */
	label?: string;
}

export type PtyDataHandler = (bytes: Uint8Array) => void;
export type PtyExitHandler = (code: number | null) => void;

/**
 * Re-exports of the raw command wrappers, in case anyone wants the imperative
 * API without the class.
 */
export { ptySpawn, ptyWrite, ptyResize, ptyKill, ptyListen, ptyScrollback };

export class Pty {
	readonly id: string;
	readonly label: string;
	exited: boolean = false;
	exitCode: number | null = null;

	private dataSubs = new Set<PtyDataHandler>();
	private exitSubs = new Set<PtyExitHandler>();
	private unlisten: (() => void) | null = null;
	private disposed = false;
	/**
	 * Owning PTYs (created via `spawn`) kill the core PTY on `dispose`. Attached
	 * PTYs (created via `attach`, e.g. a terminal popped out into a detached
	 * window) only unsubscribe — the origin pane still owns + kills the PTY.
	 */
	private owning = true;
	/**
	 * Bytes received before any subscriber registered. Held so the first
	 * `onData()` consumer can catch up on everything the PTY has emitted so
	 * far — without this, the spawn-before-mount race leaves xterm blank.
	 */
	private replayBuffer: Uint8Array = new Uint8Array(0);
	/**
	 * Absolute stream offset of `replayBuffer[0]` (cumulative bytes emitted
	 * before it), or `null` when the buffer is empty. Used by `applyScrollback`
	 * to splice a scrollback snapshot in front of live bytes buffered during a
	 * detached attach without overlap. Reset to `null` whenever the buffer
	 * drains.
	 */
	private replayStartOffset: number | null = null;
	/**
	 * When set, drop any live bytes whose absolute offset is below this value —
	 * they were already covered by a replayed scrollback snapshot. Set by
	 * `applyScrollback` when the snapshot arrives before any live bytes; cleared
	 * as soon as a live chunk crosses the threshold (offsets are monotonic).
	 */
	private dedupUpTo: number | null = null;
	/**
	 * Absolute stream offset of the last byte delivered by the underlying
	 * `pty://<id>` listener — i.e. the cumulative count of bytes this PTY has
	 * emitted so far. Updated on every `deliverData` (including buffered and
	 * deduped chunks, so it always reflects the true stream position). Read by
	 * the per-session capture ring (`pty-output-buffer.ts`) so its snapshot can
	 * be tagged with an absolute offset and reconciled against this stream —
	 * the same mechanism `applyScrollback` uses for detached-window replay.
	 */
	private totalOffset = 0;

	private constructor(id: string, label: string) {
		this.id = id;
		this.label = label;
	}

	/**
	 * Cumulative bytes this PTY has emitted (absolute stream offset of the
	 * most recent byte). Lets an external snapshot buffer (the capture ring)
	 * tag its contents with an absolute end offset comparable to this stream's
	 * offsets, so the seam between the two can be deduped rather than
	 * double-painted.
	 */
	get streamOffset(): number {
		return this.totalOffset;
	}

	/**
	 * Internal fanout. `endOffset` is the cumulative byte count this chunk ends
	 * at (its absolute start is `endOffset - bytes.length`). If no subscriber
	 * has registered yet, the bytes are appended to `replayBuffer` so the
	 * eventual `onData()` consumer can catch up; once a subscriber exists, bytes
	 * flow live. `dedupUpTo` trims bytes already delivered by a replayed
	 * scrollback snapshot (the overlap window during a detached attach).
	 */
	private deliverData(bytes: Uint8Array, endOffset: number) {
		// Track the absolute stream position first — before any dedup/return —
		// so `streamOffset` stays accurate even for chunks that get dropped.
		this.totalOffset = endOffset;
		if (this.dedupUpTo !== null) {
			const start = endOffset - bytes.length;
			if (endOffset <= this.dedupUpTo) {
				// Wholly inside the replayed snapshot — drop it. Clear the
				// threshold once we're exactly at its edge (next chunk is above).
				if (endOffset === this.dedupUpTo) this.dedupUpTo = null;
				return;
			}
			if (start < this.dedupUpTo) {
				bytes = bytes.subarray(this.dedupUpTo - start);
			}
			// This chunk crosses the threshold; all later ones are above it.
			this.dedupUpTo = null;
		}
		if (this.dataSubs.size === 0) {
			if (this.replayStartOffset === null) {
				this.replayStartOffset = endOffset - bytes.length;
			}
			const next = new Uint8Array(this.replayBuffer.length + bytes.length);
			next.set(this.replayBuffer, 0);
			next.set(bytes, this.replayBuffer.length);
			this.replayBuffer = next;
			return;
		}
		for (const sub of this.dataSubs) {
			try {
				sub(bytes);
			} catch (err) {
				console.error('[pty] data handler threw', err);
			}
		}
	}

	/**
	 * Splice a scrollback snapshot in front of whatever live bytes were buffered
	 * while attaching, so a detached (non-owning) terminal replays recent
	 * scrollback before the live stream. Called from `attach` after the live
	 * listener is registered — any bytes that arrived in between are already in
	 * `replayBuffer`, tagged by `replayStartOffset`, so the overlap between them
	 * and the snapshot is dropped by offset rather than duplicated.
	 *
	 * `snapEnd` is the cumulative byte count the snapshot ends at; its first
	 * byte's absolute offset is `snapEnd - snapData.length`. Because the live
	 * listener was registered *before* the snapshot was taken, the union of the
	 * two covers the stream with no gap: any byte below `snapEnd` is either in
	 * the snapshot's tail or was received live, and everything at/above `snapEnd`
	 * arrives live. Must run before any subscriber attaches (guaranteed by the
	 * detached surface, which only mounts xterm after `attach` resolves).
	 */
	private applyScrollback(snapData: Uint8Array, snapEnd: number) {
		if (snapData.length === 0) return;
		const snapStart = snapEnd - snapData.length;
		if (this.replayStartOffset === null) {
			// No live bytes buffered yet: replay the snapshot, and trim the
			// overlap off whatever live bytes arrive next.
			this.replayBuffer = snapData;
			this.replayStartOffset = snapStart;
			this.dedupUpTo = snapEnd;
			return;
		}
		// Live bytes already buffered. Keep only the snapshot prefix that
		// precedes them; the live buffer already carries the overlap forward.
		const liveStart = this.replayStartOffset;
		const prefixLen = Math.max(0, Math.min(snapEnd, liveStart) - snapStart);
		const prefix = snapData.subarray(0, prefixLen);
		const merged = new Uint8Array(prefix.length + this.replayBuffer.length);
		merged.set(prefix, 0);
		merged.set(this.replayBuffer, prefix.length);
		this.replayBuffer = merged;
		this.replayStartOffset = Math.min(snapStart, liveStart);
		this.dedupUpTo = null;
	}

	/**
	 * Reconcile an EXTERNAL snapshot the caller has already painted (e.g. the
	 * per-session capture ring replayed straight into xterm) against this
	 * PTY's stream. `snapEnd` is the absolute offset the caller painted up to
	 * (`streamOffset` at snapshot time). Any bytes at/below `snapEnd` — whether
	 * already buffered in `replayBuffer` for a not-yet-attached subscriber or
	 * arriving live afterwards — are dropped, so the seam is not double-painted.
	 *
	 * Same offset arithmetic as `applyScrollback`, minus the prepend: the
	 * caller owns the snapshot bytes and only needs this Pty to suppress the
	 * overlap. Must be called BEFORE the consuming `onData()` subscriber
	 * attaches (so the buffered replay is trimmed before it is drained). No-op
	 * on an empty snapshot. Offsets are monotonic.
	 */
	primeExternalSnapshot(snapEnd: number) {
		if (snapEnd <= 0) return;
		if (this.replayStartOffset !== null) {
			const start = this.replayStartOffset;
			const end = start + this.replayBuffer.length;
			if (snapEnd >= end) {
				// Whole buffer already covered by the external snapshot.
				this.replayBuffer = new Uint8Array(0);
				this.replayStartOffset = null;
			} else if (snapEnd > start) {
				// Drop the covered prefix; keep the tail beyond the seam.
				this.replayBuffer = this.replayBuffer.subarray(snapEnd - start);
				this.replayStartOffset = snapEnd;
			}
			// else snapEnd <= start: buffer is wholly after the seam — keep it.
		}
		// Suppress future live bytes below the seam (self-clears once the
		// stream crosses `snapEnd`, per `deliverData`).
		this.dedupUpTo = snapEnd;
	}

	/**
	 * Spawn a new PTY and start listening on its event streams.
	 */
	static async spawn(opts: PtySpawnOpts): Promise<Pty> {
		const id = await ptySpawn({
			cwd: opts.cwd,
			cmd: opts.cmd,
			env: opts.env,
			rows: opts.rows,
			cols: opts.cols,
		});
		const pty = new Pty(id, opts.label ?? opts.cmd.join(' '));
		try {
			pty.unlisten = await ptyListen(
				id,
				(bytes, endOffset) => pty.deliverData(bytes, endOffset),
				(code) => {
					pty.exited = true;
					pty.exitCode = code;
					for (const sub of pty.exitSubs) {
						try {
							sub(code);
						} catch (err) {
							console.error('[pty] exit handler threw', err);
						}
					}
				}
			);
		} catch (err) {
			// If we failed to subscribe, kill the orphan to avoid leaks.
			await ptyKill(id).catch(() => {});
			throw err;
		}
		return pty;
	}

	/**
	 * Attach to an EXISTING PTY by id (a terminal popped out into a detached
	 * window). Subscribes to the live `pty://<id>` stream without spawning —
	 * the origin pane still owns the PTY, so `dispose()` here only unsubscribes
	 * and never kills it. New output + keystrokes flow live and write back to
	 * the shared shell (both windows drive the same PTY).
	 *
	 * Scrollback: the live listener is registered FIRST, then a scrollback
	 * snapshot is fetched and spliced in front of any bytes that arrived in the
	 * meantime (`applyScrollback` drops the overlap by offset). This closes the
	 * gap where a popped-out terminal started blank until fresh output arrived.
	 * The replayed bytes are the raw trailing stream, so — like any terminal
	 * reattach — mid-state escape sequences render against a fresh screen; a few
	 * stale bytes may flicker at the top on first paint. Scrollback older than
	 * the Rust ring cap (256KB) is not replayed.
	 */
	static async attach(id: string, label: string): Promise<Pty> {
		const pty = new Pty(id, label);
		pty.owning = false;
		pty.unlisten = await ptyListen(
			id,
			(bytes, endOffset) => pty.deliverData(bytes, endOffset),
			(code) => {
				pty.exited = true;
				pty.exitCode = code;
				for (const sub of pty.exitSubs) {
					try {
						sub(code);
					} catch (err) {
						console.error('[pty] exit handler threw', err);
					}
				}
			}
		);
		// Replay recent scrollback before any subscriber attaches. Registered
		// after the live listener so the union covers the stream gap-free.
		try {
			const sb = await ptyScrollback(id);
			if (sb) pty.applyScrollback(sb.data, sb.endOffset);
		} catch (err) {
			console.warn('[pty] scrollback fetch failed', err);
		}
		return pty;
	}

	/**
	 * Subscribe to data bytes. Returns an unsubscribe function. If bytes have
	 * already been buffered (received before any subscriber attached), the new
	 * handler receives them synchronously before subscribing to the live stream.
	 */
	onData(handler: PtyDataHandler): () => void {
		if (this.replayBuffer.length > 0) {
			try {
				handler(this.replayBuffer);
			} catch (err) {
				console.error('[pty] data handler threw on replay', err);
			}
			// Drain the buffer so a later subscribe-after-yield doesn't replay
			// bytes the first subscriber already saw. Between unsubscribe and
			// re-subscribe (Studio attach window), new bytes go into a fresh
			// buffer and drain into the late subscriber once it attaches.
			this.replayBuffer = new Uint8Array(0);
			this.replayStartOffset = null;
		}
		this.dataSubs.add(handler);
		return () => {
			this.dataSubs.delete(handler);
		};
	}

	/**
	 * Subscribe to exit. If the PTY has already exited, the handler is fired
	 * synchronously on the next microtask with the recorded exit code.
	 */
	onExit(handler: PtyExitHandler): () => void {
		if (this.exited) {
			queueMicrotask(() => handler(this.exitCode));
			return () => {};
		}
		this.exitSubs.add(handler);
		return () => {
			this.exitSubs.delete(handler);
		};
	}

	async write(data: string): Promise<void> {
		if (this.disposed || this.exited) return;
		return ptyWrite(this.id, data);
	}

	async resize(rows: number, cols: number): Promise<void> {
		if (this.disposed || this.exited) return;
		return ptyResize(this.id, rows, cols);
	}

	async kill(): Promise<void> {
		if (this.disposed || this.exited) return;
		return ptyKill(this.id);
	}

	/** Stop listeners and kill the PTY. Idempotent. */
	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		try {
			this.unlisten?.();
		} catch {
			/* ignore */
		}
		this.unlisten = null;
		this.dataSubs.clear();
		this.exitSubs.clear();
		// Attached (non-owning) PTYs only detach their listener; the origin pane
		// owns the PTY lifecycle. Only an owning PTY kills the core process.
		if (this.owning && !this.exited) {
			await ptyKill(this.id).catch(() => {});
		}
	}
}
