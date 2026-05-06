import { useEffect, useRef } from 'react';
import { Clapperboard, RefreshCw } from 'lucide-react';
import { useStoryboard } from '@/lib/video/hooks';
import { registerIykeIframe } from '@/lib/iyke/iframe-registry';

/**
 * Full-pane embed of the storyboard-app dev server (Vite on 3105 + Express
 * on 3106), served by the pa-storyboard sidecar.
 *
 * Boot is slower than the other sidecars (~5–10s) because the Vite dev
 * server compiles on first request and the sidecar waits for an /api/health
 * 200 before emitting `ready` — which proves both halves of the stack are
 * up before we mount the iframe.
 */
interface StoryboardPaneProps {
  paneId: string;
}

export function StoryboardPane({ paneId }: StoryboardPaneProps) {
  const { status, restart } = useStoryboard();
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  useEffect(() => {
    const el = iframeRef.current;
    if (!el) return;
    return registerIykeIframe(paneId, el, 'storyboard');
  }, [paneId, status.kind === 'ready' ? status.port : null]);

  if (status.kind === 'idle' || status.kind === 'booting') {
    return (
      <div className="flex h-full w-full items-center justify-center bg-muted/20">
        <div className="text-center">
          <Clapperboard className="mx-auto mb-3 h-8 w-8 animate-pulse text-muted-foreground" />
          <div className="text-sm text-muted-foreground">Booting Storyboard…</div>
          <div className="mt-1 text-[11px] text-muted-foreground italic">
            Vite + Express, takes a few seconds on first run.
          </div>
        </div>
      </div>
    );
  }

  if (status.kind === 'crashed') {
    return (
      <div className="flex h-full w-full items-center justify-center bg-muted/20 p-6">
        <div className="max-w-md text-center">
          <Clapperboard className="mx-auto mb-3 h-8 w-8 text-destructive" />
          <div className="text-sm font-medium text-foreground">Storyboard crashed</div>
          <div className="mt-2 text-xs text-muted-foreground">{status.reason}</div>
          <button
            type="button"
            onClick={restart}
            className="mt-4 inline-flex items-center gap-1 rounded border border-border bg-background px-3 py-1 text-xs hover:bg-muted"
          >
            <RefreshCw className="h-3 w-3" />
            Restart
          </button>
        </div>
      </div>
    );
  }

  const url = `http://127.0.0.1:${status.port}`;
  return (
    <iframe
      key={url}
      ref={iframeRef}
      src={url}
      title="Storyboard"
      className="h-full w-full border-0 bg-background"
    />
  );
}
