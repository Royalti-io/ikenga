import { useEffect, useState } from 'react';

import { Pty } from '@/terminal/pty-bridge';
import { XTermHost } from '@/terminal/xterm-host';

/**
 * Attaches an xterm host to a PTY id that was spawned out-of-band by
 * `claude_spawn_session`. Lifecycle: this component owns the *attachment*
 * (subscribe/unsubscribe), but does not own the PTY itself — closing the
 * route doesn't kill the claude process.
 */
export function LiveTerminal({ ptyId }: { ptyId: string }) {
  const [pty, setPty] = useState<Pty | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let attached: Pty | null = null;
    Pty.attach(ptyId, `claude://${ptyId}`)
      .then((p) => {
        if (cancelled) {
          // Detach silently if the route closed before we connected.
          p.dispose().catch(() => {});
          return;
        }
        attached = p;
        setPty(p);
      })
      .catch((err) => setError(String(err)));
    return () => {
      cancelled = true;
      attached?.dispose().catch(() => {});
    };
  }, [ptyId]);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-destructive">
        Could not attach to PTY: {error}
      </div>
    );
  }
  if (!pty) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        Attaching to live session…
      </div>
    );
  }
  return <XTermHost pty={pty} />;
}
