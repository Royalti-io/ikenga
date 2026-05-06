import { useEffect, useRef } from 'react';
import { Film, RefreshCw } from 'lucide-react';
import { useVideoStudio } from '@/lib/video/hooks';
import { registerIykeIframe } from '@/lib/iyke/iframe-registry';

/**
 * Full-pane embed of the Remotion Studio dev server, served by the
 * pa-video-studio sidecar at http://127.0.0.1:<port>.
 *
 * The hook manages lifecycle: starts on mount, listens for crashes, and
 * exposes a restart() handler. The iframe is recreated whenever `port`
 * changes (key on the URL) so a restart fully reloads Studio.
 */
interface VideoStudioPaneProps {
  paneId: string;
}

export function VideoStudioPane({ paneId }: VideoStudioPaneProps) {
  const { status, restart } = useVideoStudio();
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  useEffect(() => {
    const el = iframeRef.current;
    if (!el) return;
    return registerIykeIframe(paneId, el, 'video-engine');
  }, [paneId, status.kind === 'ready' ? status.port : null]);

  if (status.kind === 'idle' || status.kind === 'booting') {
    return (
      <div className="flex h-full w-full items-center justify-center bg-muted/20">
        <div className="text-center">
          <Film className="mx-auto mb-3 h-8 w-8 animate-pulse text-muted-foreground" />
          <div className="text-sm text-muted-foreground">Booting Remotion Studio…</div>
        </div>
      </div>
    );
  }

  if (status.kind === 'crashed') {
    return (
      <div className="flex h-full w-full items-center justify-center bg-muted/20 p-6">
        <div className="max-w-md text-center">
          <Film className="mx-auto mb-3 h-8 w-8 text-destructive" />
          <div className="text-sm font-medium text-foreground">Studio crashed</div>
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
      title="Remotion Studio"
      className="h-full w-full border-0 bg-background"
      // sandbox left open — Studio needs WebSocket, fetch, and clipboard.
    />
  );
}
