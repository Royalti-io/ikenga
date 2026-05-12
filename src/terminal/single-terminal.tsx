import { useEffect, useRef, useState } from 'react';
import { defaultCwd } from '@/lib/shell/default-cwd';
import { XTermHost } from './xterm-host';
import { Pty } from './pty-bridge';
import { useTerminalStore } from './session-store';
import { disposePty, getPty, registerPty } from './pty-registry';

interface SingleTerminalProps {
  sessionId: string;
}

// Hosts exactly one PTY inside a pane tab. The session record (cwd, cmd,
// title, status) lives in the terminal-store; the live PTY lives in the
// module-level registry so it survives pane-tree remounts.
export function SingleTerminal({ sessionId }: SingleTerminalProps) {
  const tab = useTerminalStore((s) => s.tabs.find((t) => t.id === sessionId));
  const setStatus = useTerminalStore((s) => s.setStatus);
  const setPtyId = useTerminalStore((s) => s.setPtyId);

  const [pty, setPty] = useState<Pty | null>(() => getPty(sessionId) ?? null);
  const startedRef = useRef(false);

  // Spawn lifecycle: if the tab is in 'spawning' status with no live PTY,
  // call Pty.spawn(). On exit, update store status. Stays idempotent across
  // remounts via the registry + startedRef guard.
  useEffect(() => {
    if (!tab) return;
    if (startedRef.current) return;
    if (pty) return;
    if (tab.status !== 'spawning') return;
    startedRef.current = true;
    let cancelled = false;
    (async () => {
      try {
        const p = await Pty.spawn({
          cwd: tab.spec.cwd,
          cmd: tab.spec.cmd,
          env: tab.spec.env,
          label: tab.spec.cmd.join(' '),
        });
        if (cancelled) {
          await p.dispose().catch(() => {});
          return;
        }
        p.onExit((code) => {
          // Drop the dead PTY from the registry so a click-to-respawn finds
          // a clean slate.
          disposePty(sessionId);
          setStatus(sessionId, 'exited', code);
        });
        registerPty(sessionId, p);
        setPty(p);
        setPtyId(sessionId, p.id);
        setStatus(sessionId, 'running');
      } catch (err) {
        console.error('[single-terminal] spawn failed', err);
        setStatus(sessionId, 'error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tab, pty, sessionId, setPtyId, setStatus]);

  // Allow respawn — when status flips back to 'spawning' (manual respawn),
  // reset the spawn guard so the effect above takes another shot.
  useEffect(() => {
    if (tab?.status === 'spawning') {
      startedRef.current = false;
      if (pty?.exited) setPty(null);
    }
  }, [tab?.status, pty]);

  if (!tab) {
    return (
      <Centered text={`Terminal session ${sessionId.slice(0, 8)}… not found.`} />
    );
  }
  if (!pty) {
    if (tab.status === 'exited') {
      return (
        <Centered>
          Terminal exited (code={tab.exitCode ?? '?'}).
          <br />
          <button
            type="button"
            onClick={() => setStatus(sessionId, 'spawning')}
            className="mt-2 rounded-md border border-border bg-background px-3 py-1 text-xs hover:bg-accent"
          >
            Restart <code className="ml-1 font-mono">{tab.spec.cmd.join(' ')}</code>
          </button>
        </Centered>
      );
    }
    if (tab.status === 'error') {
      return (
        <Centered text={`Failed to spawn: ${tab.spec.cmd.join(' ')}`} className="text-destructive" />
      );
    }
    return <Centered text={`Spawning ${tab.spec.cmd.join(' ')}…`} />;
  }
  return <XTermHost pty={pty} />;
}

interface CenteredProps {
  text?: string;
  className?: string;
  children?: React.ReactNode;
}

function Centered({ text, className, children }: CenteredProps) {
  return (
    <div
      className={`flex h-full w-full items-center justify-center bg-background p-6 text-center text-xs text-muted-foreground ${className ?? ''}`}
    >
      <div>{text ?? children}</div>
    </div>
  );
}

// Helper to create a new terminal session and return its id. Caller wires
// it into a pane tab via paneStore.addTab(focusedId, { kind: 'terminal',
// sessionId: id }).
export function createTerminalSession(opts?: {
  cwd?: string;
  cmd?: string[];
  title?: string;
}): string {
  const cwd = opts?.cwd ?? defaultCwd();
  const cmd = opts?.cmd ?? ['bash', '-l'];
  return useTerminalStore.getState().add({ cwd, cmd }, opts?.title);
}
