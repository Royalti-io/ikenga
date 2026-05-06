import { useEffect, useRef, useState } from 'react';
import { RefreshCw, Sparkles } from 'lucide-react';
import { listHyperframesProjects, useHyperframes } from '@/lib/video/hooks';
import { registerIykeIframe } from '@/lib/iyke/iframe-registry';

/**
 * Full-pane embed of HyperFrames preview. When no project is active we
 * show a project picker; selecting one boots its preview server.
 *
 * Each pane tab persists its own project selection under
 * `hf:project:<paneId>` in localStorage, so different panes can host
 * different projects and a tab restore brings back whatever was selected.
 * The HyperFrames sidecar runs one preview server per slug, so multiple
 * panes can show different projects concurrently.
 */
interface HyperframesPaneProps {
  paneId: string;
}

const projectStorageKey = (paneId: string) => `hf:project:${paneId}`;

export function HyperframesPane({ paneId }: HyperframesPaneProps) {
  const [projects, setProjects] = useState<string[]>([]);
  const [project, setProjectState] = useState<string | null>(() => {
    try {
      return localStorage.getItem(projectStorageKey(paneId));
    } catch {
      return null;
    }
  });
  const setProject = (next: string | null) => {
    setProjectState(next);
    try {
      const key = projectStorageKey(paneId);
      if (next) localStorage.setItem(key, next);
      else localStorage.removeItem(key);
    } catch {
      // ignore — non-fatal, just lose persistence on this pane
    }
  };
  const { status, restart } = useHyperframes(project);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  useEffect(() => {
    const el = iframeRef.current;
    if (!el) return;
    return registerIykeIframe(paneId, el, 'hyperframes');
  }, [paneId, status.kind === 'ready' ? status.port : null]);

  // Load project list on mount. Project selection comes from per-pane
  // localStorage (above) — never from the sidecar's global status, which
  // would clobber pane B with whatever pane A last opened.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await listHyperframesProjects();
        if (cancelled) return;
        setProjects(list);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('hyperframes: failed to load projects', e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!project) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-muted/20 p-6">
        <div className="w-full max-w-sm text-center">
          <Sparkles className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
          <div className="text-sm font-medium text-foreground">Pick a HyperFrames project</div>
          {projects.length === 0 ? (
            <div className="mt-3 text-xs text-muted-foreground italic">
              No projects found in <code>hyperframes-projects/</code>.
            </div>
          ) : (
            <div className="mt-4 flex flex-col gap-1">
              {projects.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setProject(p)}
                  className="rounded border border-border bg-background px-3 py-1.5 text-left text-xs hover:bg-muted"
                >
                  {p}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (status.kind === 'idle' || status.kind === 'booting') {
    return (
      <div className="flex h-full w-full items-center justify-center bg-muted/20">
        <div className="text-center">
          <Sparkles className="mx-auto mb-3 h-8 w-8 animate-pulse text-muted-foreground" />
          <div className="text-sm text-muted-foreground">
            Booting HyperFrames preview ({project})…
          </div>
        </div>
      </div>
    );
  }

  if (status.kind === 'crashed') {
    return (
      <div className="flex h-full w-full items-center justify-center bg-muted/20 p-6">
        <div className="max-w-md text-center">
          <Sparkles className="mx-auto mb-3 h-8 w-8 text-destructive" />
          <div className="text-sm font-medium text-foreground">Preview crashed</div>
          <div className="mt-1 text-xs text-muted-foreground italic">project: {project}</div>
          <div className="mt-2 text-xs text-muted-foreground">{status.reason}</div>
          <div className="mt-4 flex justify-center gap-2">
            <button
              type="button"
              onClick={restart}
              className="inline-flex items-center gap-1 rounded border border-border bg-background px-3 py-1 text-xs hover:bg-muted"
            >
              <RefreshCw className="h-3 w-3" />
              Restart
            </button>
            <button
              type="button"
              onClick={() => setProject(null)}
              className="rounded border border-border bg-background px-3 py-1 text-xs hover:bg-muted"
            >
              Pick another project
            </button>
          </div>
        </div>
      </div>
    );
  }

  const url = `http://127.0.0.1:${status.port}`;
  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex h-7 shrink-0 items-center justify-between border-b border-border bg-card px-3 text-xs text-muted-foreground">
        <span>HyperFrames · {project}</span>
        <button
          type="button"
          onClick={() => setProject(null)}
          className="text-muted-foreground hover:text-foreground"
        >
          switch project
        </button>
      </div>
      <iframe
        key={url}
        ref={iframeRef}
        src={url}
        title={`HyperFrames preview · ${project}`}
        className="flex-1 border-0 bg-background"
      />
    </div>
  );
}
