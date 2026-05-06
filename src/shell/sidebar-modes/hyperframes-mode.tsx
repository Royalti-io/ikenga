import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { usePaneStore } from '@/lib/panes/pane-store';
import { listHyperframesProjects } from '@/lib/video/hooks';

/**
 * Sidebar surface for HyperFrames. Lists projects from the bundled
 * `hyperframes-projects/` dir. Clicking a project opens (or focuses) a
 * mini-app pane tab. The pane itself owns the per-project preview lifecycle
 * via useHyperframes(project), so the sidebar just dispatches.
 */
export function HyperframesMode() {
  const [projects, setProjects] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const addTab = usePaneStore((s) => s.addTab);
  const focusedId = usePaneStore((s) => s.focusedId);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await listHyperframesProjects();
        if (!cancelled) setProjects(list);
      } catch (e) {
        if (!cancelled) setError((e as Error).message ?? String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const openPane = () => {
    addTab(focusedId, { kind: 'mini-app', name: 'hyperframes' });
  };

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-3 py-2 text-[11px] uppercase tracking-wider text-muted-foreground">
        HyperFrames
      </div>

      <div className="flex-1 overflow-auto p-2">
        <button
          type="button"
          onClick={openPane}
          className="mb-2 flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
        >
          <Sparkles className="h-4 w-4 text-muted-foreground" />
          <span>Open Preview</span>
        </button>

        <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">
          Projects
        </div>

        {error ? (
          <div className="px-2 py-1 text-xs text-destructive">{error}</div>
        ) : projects === null ? (
          <div className="px-2 py-1 text-xs text-muted-foreground italic">Loading…</div>
        ) : projects.length === 0 ? (
          <div className="px-2 py-1 text-xs text-muted-foreground italic">
            No projects in <code>hyperframes-projects/</code>
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {projects.map((p) => (
              <button
                key={p}
                type="button"
                onClick={openPane}
                className="rounded px-2 py-1 text-left text-xs text-foreground hover:bg-muted"
                title="Open in pane (project picker shown if first run)"
              >
                {p}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="border-t border-border p-3 text-[11px] text-muted-foreground">
        HTML+GSAP compositions. Each project boots its own preview server on
        demand.
      </div>
    </div>
  );
}
