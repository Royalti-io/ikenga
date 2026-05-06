import { useNavigate } from '@tanstack/react-router';
import { Clapperboard, FileEdit } from 'lucide-react';
import { usePaneStore } from '@/lib/panes/pane-store';

/**
 * Sidebar surface for the Storyboard rail icon. Two doors:
 *   1. "Open Storyboard App" — opens the external Vite/Express
 *      storyboard-app via the pa-storyboard sidecar (full review/approve UI).
 *   2. "In-app Editor" — keeps the Tauri-native /storyboard routes
 *      reachable for quick captures without booting the dev server.
 */
export function StoryboardMode() {
  const navigate = useNavigate();
  const addTab = usePaneStore((s) => s.addTab);
  const focusedId = usePaneStore((s) => s.focusedId);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-3 py-2 text-[11px] uppercase tracking-wider text-muted-foreground">
        Storyboard
      </div>
      <div className="flex flex-col gap-1 p-2">
        <button
          type="button"
          onClick={() => addTab(focusedId, { kind: 'mini-app', name: 'storyboard' })}
          className="flex items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
        >
          <Clapperboard className="h-4 w-4 text-muted-foreground" />
          <span>Open Storyboard App</span>
        </button>
        <button
          type="button"
          onClick={() => navigate({ to: '/storyboard' })}
          className="flex items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
        >
          <FileEdit className="h-4 w-4 text-muted-foreground" />
          <span>In-app Editor</span>
        </button>
      </div>
      <div className="mt-auto border-t border-border p-3 text-[11px] text-muted-foreground">
        The full app is the Vite/Express dev pair from
        royalti-video-engine/storyboard-app. Boots on demand.
      </div>
    </div>
  );
}
