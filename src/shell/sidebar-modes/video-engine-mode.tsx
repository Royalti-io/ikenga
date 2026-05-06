import { useNavigate } from '@tanstack/react-router';
import { Film, ListVideo, Play } from 'lucide-react';
import { usePaneStore } from '@/lib/panes/pane-store';

/**
 * Sidebar surface for the Video Engine rail icon. Two doors:
 *   1. "Open Studio" — adds a {kind:'mini-app', name:'video-engine'} tab to
 *      the focused pane, which renders VideoStudioPane (iframe → sidecar).
 *   2. Quick links into the existing /video page-nav routes (lite player +
 *      render queue), addressed via the router-pane sync.
 */
export function VideoEngineMode() {
  const navigate = useNavigate();
  const addTab = usePaneStore((s) => s.addTab);
  const focusedId = usePaneStore((s) => s.focusedId);

  const openStudio = () => {
    addTab(focusedId, { kind: 'mini-app', name: 'video-engine' });
  };

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-3 py-2 text-[11px] uppercase tracking-wider text-muted-foreground">
        Video Engine
      </div>
      <div className="flex flex-col gap-1 p-2">
        <button
          type="button"
          onClick={openStudio}
          className="flex items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
        >
          <Film className="h-4 w-4 text-muted-foreground" />
          <span>Open Studio</span>
        </button>
        <button
          type="button"
          onClick={() => navigate({ to: '/video' })}
          className="flex items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
        >
          <Play className="h-4 w-4 text-muted-foreground" />
          <span>Compositions</span>
        </button>
        <button
          type="button"
          onClick={() => navigate({ to: '/video/queue' })}
          className="flex items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
        >
          <ListVideo className="h-4 w-4 text-muted-foreground" />
          <span>Render Queue</span>
        </button>
      </div>
      <div className="mt-auto border-t border-border p-3 text-[11px] text-muted-foreground">
        Studio runs as a sidecar process. First boot takes 2–4s while the
        composition bundle compiles.
      </div>
    </div>
  );
}
