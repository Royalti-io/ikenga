import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import {
  Clapperboard,
  FileEdit,
  Film,
  ListVideo,
  Play,
  Sparkles,
} from 'lucide-react';
import { usePaneStore } from '@/lib/panes/pane-store';
import {
  listActiveHyperframes,
  listHyperframesProjects,
  type HyperframesStarted,
} from '@/lib/video/hooks';

/**
 * Unified Studio rail surface — replaces the separate storyboard,
 * video-engine, and hyperframes rail modes. Three sections drive the
 * same set of mini-app pane tabs and routes that the old modes did.
 */
export function StudioMode() {
  const navigate = useNavigate();
  const addTab = usePaneStore((s) => s.addTab);
  const focusedId = usePaneStore((s) => s.focusedId);

  const [projects, setProjects] = useState<string[] | null>(null);
  const [hfError, setHfError] = useState<string | null>(null);
  const [actives, setActives] = useState<HyperframesStarted[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await listHyperframesProjects();
        if (!cancelled) setProjects(list);
      } catch (e) {
        if (!cancelled) setHfError((e as Error).message ?? String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Poll active previews so the sidebar shows which projects are live and
  // the user knows when they're approaching the sidecar's concurrency cap.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const list = await listActiveHyperframes();
        if (!cancelled) setActives(list);
      } catch {
        // sidecar not ready yet; next tick will retry
      }
    };
    void tick();
    const id = window.setInterval(tick, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);
  const activeSlugs = new Set(actives.map((a) => a.project));

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <Section title="Storyboard">
        <RailButton
          Icon={Clapperboard}
          label="Open Storyboard App"
          onClick={() => addTab(focusedId, { kind: 'mini-app', name: 'storyboard' })}
        />
        <RailButton
          Icon={FileEdit}
          label="In-app Editor"
          onClick={() => navigate({ to: '/storyboard' })}
        />
      </Section>

      <Section title="Compositions">
        <RailButton
          Icon={Film}
          label="Open Studio"
          onClick={() => addTab(focusedId, { kind: 'mini-app', name: 'video-engine' })}
        />
        <RailButton
          Icon={Play}
          label="Compositions"
          onClick={() => navigate({ to: '/video' })}
        />
        <RailButton
          Icon={ListVideo}
          label="Render Queue"
          onClick={() => navigate({ to: '/video/queue' })}
        />
      </Section>

      <Section title="HyperFrames">
        <RailButton
          Icon={Sparkles}
          label="Open Preview"
          onClick={() => addTab(focusedId, { kind: 'mini-app', name: 'hyperframes' })}
        />

        <div className="flex items-center justify-between px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">
          <span>Projects</span>
          {actives.length > 0 ? (
            <span title={actives.map((a) => `${a.project} :${a.port}`).join('\n')}>
              {actives.length} active
            </span>
          ) : null}
        </div>

        {hfError ? (
          <div className="px-2 py-1 text-xs text-destructive">{hfError}</div>
        ) : projects === null ? (
          <div className="px-2 py-1 text-xs text-muted-foreground italic">Loading…</div>
        ) : projects.length === 0 ? (
          <div className="px-2 py-1 text-xs text-muted-foreground italic">
            No projects in <code>hyperframes-projects/</code>
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {projects.map((p) => {
              const isActive = activeSlugs.has(p);
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() => addTab(focusedId, { kind: 'mini-app', name: 'hyperframes' })}
                  className="flex items-center justify-between rounded px-2 py-1 text-left text-xs text-foreground hover:bg-muted"
                  title={isActive ? 'Active — open in pane' : 'Open in pane'}
                >
                  <span>{p}</span>
                  {isActive ? (
                    <span
                      aria-label="active"
                      className="ml-2 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500"
                    />
                  ) : null}
                </button>
              );
            })}
          </div>
        )}
      </Section>

      <div className="mt-auto border-t border-border p-3 text-[11px] text-muted-foreground">
        Studio surfaces (Storyboard / Video / HyperFrames) run as sidecar processes. First
        boot takes a few seconds while bundles compile.
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-border">
      <div className="border-b border-border px-3 py-2 text-[11px] uppercase tracking-wider text-muted-foreground">
        {title}
      </div>
      <div className="flex flex-col gap-1 p-2">{children}</div>
    </div>
  );
}

function RailButton({
  Icon,
  label,
  onClick,
}: {
  Icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
    >
      <Icon className="h-4 w-4 text-muted-foreground" />
      <span>{label}</span>
    </button>
  );
}
