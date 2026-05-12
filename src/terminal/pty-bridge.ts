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
  ptyConsumeBuffer,
  ptyKill,
  ptyListen,
  ptyResize,
  ptySpawn,
  ptyWrite,
  type PtySpawnOpts as RawPtySpawnOpts,
} from "../lib/tauri-cmd";

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
export { ptySpawn, ptyWrite, ptyResize, ptyKill, ptyListen };

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
   * Bytes received before any subscriber registered, plus the initial
   * scrollback replay from Rust. Held so the first `onData()` consumer can
   * catch up on everything the PTY has emitted so far — without this, the
   * spawn-before-mount race leaves xterm blank for healthy sessions and
   * silent for sessions where `claude` exited fast.
   */
  private replayBuffer: Uint8Array = new Uint8Array(0);

  private constructor(id: string, label: string) {
    this.id = id;
    this.label = label;
  }

  /**
   * Internal fanout used by both spawn() and attach() Tauri listeners. If no
   * subscriber has registered yet, the bytes are appended to `replayBuffer`
   * so the eventual `onData()` consumer can catch up; once a subscriber
   * exists, bytes flow live.
   */
  private deliverData(bytes: Uint8Array) {
    if (this.dataSubs.size === 0) {
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
        console.error("[pty] data handler threw", err);
      }
    }
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
    const pty = new Pty(id, opts.label ?? opts.cmd.join(" "));
    try {
      pty.unlisten = await ptyListen(
        id,
        (bytes) => pty.deliverData(bytes),
        (code) => {
          pty.exited = true;
          pty.exitCode = code;
          for (const sub of pty.exitSubs) {
            try {
              sub(code);
            } catch (err) {
              console.error("[pty] exit handler threw", err);
            }
          }
        },
      );
    } catch (err) {
      // If we failed to subscribe, kill the orphan to avoid leaks.
      await ptyKill(id).catch(() => {});
      throw err;
    }
    return pty;
  }

  /**
   * Attach to a PTY that was spawned out-of-band (e.g. `claude_spawn_session`
   * which spawns through Rust directly). The frontend just subscribes to the
   * existing event stream — it does not own the lifecycle, so `dispose()` on
   * an attached Pty unsubscribes but does not kill the child by default.
   */
  static async attach(id: string, label?: string): Promise<Pty> {
    const pty = new Pty(id, label ?? id);
    pty.unlisten = await ptyListen(
      id,
      (bytes) => pty.deliverData(bytes),
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
      },
    );
    // Replay the scrollback that accumulated between Rust's `pty_spawn` and
    // our `ptyListen` above. Order matters: subscribe first (so any bytes
    // emitted *during* this await land in `replayBuffer` via deliverData),
    // then prepend the snapshot. The duplicate window is the few ms between
    // listener attach and snapshot return — terminal output is idempotent
    // enough under redraw that occasional double bytes are invisible.
    try {
      const snapshot = await ptyConsumeBuffer(id);
      if (snapshot.length > 0) {
        const next = new Uint8Array(snapshot.length + pty.replayBuffer.length);
        next.set(snapshot, 0);
        next.set(pty.replayBuffer, snapshot.length);
        pty.replayBuffer = next;
      }
    } catch (err) {
      console.warn('[pty] scrollback replay failed', err);
    }
    return pty;
  }

  /**
   * Subscribe to data bytes. Returns an unsubscribe function. If bytes have
   * already been buffered (scrollback replay + bytes received before any
   * subscriber attached), the new handler receives them synchronously before
   * subscribing to the live stream.
   */
  onData(handler: PtyDataHandler): () => void {
    if (this.replayBuffer.length > 0) {
      try {
        handler(this.replayBuffer);
      } catch (err) {
        console.error("[pty] data handler threw on replay", err);
      }
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
    if (!this.exited) {
      await ptyKill(this.id).catch(() => {});
    }
  }
}
