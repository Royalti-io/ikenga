import { useState } from "react";
import { Link, createLazyFileRoute } from "@tanstack/react-router";
import { ChevronLeft, CircleStop, Play } from "lucide-react";

import { Button } from "@/components/ui/button";
import { VideoPlayer } from "@/video/player";
import { PropsEditor } from "@/video/props-editor";
import {
  getRegistry,
  type CompositionDefinition,
} from "@/video/registry";
import { defaultOutputPath, useRender } from "@/video/use-render";

export const Route = createLazyFileRoute("/video/$compositionId")({
  component: CompositionRoute,
});

function CompositionRoute() {
  const { compositionId } = Route.useParams();
  const composition = getRegistry().find((c) => c.id === compositionId);
  if (!composition) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        No composition with id <code className="rounded bg-muted px-1 py-0.5 text-xs">{compositionId}</code>.
        <Link to="/video" className="ml-2 underline">Back</Link>
      </div>
    );
  }
  return <CompositionEditor composition={composition} />;
}

function CompositionEditor({ composition }: { composition: CompositionDefinition }) {
  const [props, setProps] = useState<Record<string, unknown>>(
    () => ({ ...composition.defaultProps }),
  );
  const render = useRender();
  const isRunning = render.state.status === "starting" || render.state.status === "running";

  function handleRender() {
    render.start(composition.id, props, defaultOutputPath(composition.id));
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between gap-4 border-b border-border px-6 py-4">
        <div className="flex items-center gap-3">
          <Link
            to="/video"
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
          >
            <ChevronLeft className="h-3 w-3" />
            Compositions
          </Link>
          <h1 className="text-lg font-semibold">{composition.id}</h1>
          <span className="text-xs text-muted-foreground">
            {composition.width}×{composition.height} ·{" "}
            {(composition.durationInFrames / composition.fps).toFixed(1)}s @ {composition.fps}fps
          </span>
        </div>
        {isRunning ? (
          <Button size="sm" variant="destructive" onClick={() => render.cancel()}>
            <CircleStop className="mr-1 h-4 w-4" />
            Cancel
          </Button>
        ) : (
          <Button size="sm" onClick={handleRender}>
            <Play className="mr-1 h-4 w-4" />
            Render
          </Button>
        )}
      </header>
      {(isRunning || render.state.status !== "idle") && (
        <RenderStatusBanner state={render.state} onReset={render.reset} />
      )}
      <div className="grid flex-1 grid-cols-[1fr_320px] gap-6 overflow-auto px-6 py-4">
        <div className="flex items-start justify-center">
          <VideoPlayer composition={composition} inputProps={props} />
        </div>
        <aside className="flex flex-col gap-3">
          <h2 className="font-mono text-xs uppercase tracking-wide text-muted-foreground">
            Props
          </h2>
          <PropsEditor schema={composition.schema} value={props} onChange={setProps} />
          <hr className="my-2 border-border" />
          <h2 className="font-mono text-xs uppercase tracking-wide text-muted-foreground">
            Beats
          </h2>
          <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
            {composition.beats?.map((b) => (
              <li key={b.id} className="flex justify-between gap-2 font-mono">
                <span>{b.label}</span>
                <span className="tabular-nums">
                  {b.time.start.toFixed(1)}s–{b.time.end.toFixed(1)}s
                </span>
              </li>
            )) ?? <li className="italic">No beats declared.</li>}
          </ul>
        </aside>
      </div>
    </div>
  );
}

function RenderStatusBanner({
  state,
  onReset,
}: {
  state: ReturnType<typeof useRender>["state"];
  onReset: () => void;
}) {
  const pct = state.progress == null ? null : Math.round(state.progress * 100);
  const colorByStatus: Record<string, string> = {
    starting: "bg-muted",
    running: "bg-primary/20",
    complete: "bg-emerald-500/20 text-emerald-700 dark:text-emerald-400",
    error: "bg-destructive/15 text-destructive",
    cancelled: "bg-muted",
  };
  const klass = colorByStatus[state.status] ?? "bg-muted";

  return (
    <div className={`flex items-center gap-3 border-b border-border px-6 py-2 text-xs ${klass}`}>
      <span className="font-mono uppercase tracking-wide">{state.status}</span>
      {pct !== null && (
        <div className="relative h-1 flex-1 overflow-hidden rounded-full bg-foreground/10">
          <div
            className="absolute inset-y-0 left-0 bg-primary transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
      {pct !== null && <span className="font-mono tabular-nums">{pct}%</span>}
      {state.outputPath && (
        <span className="truncate font-mono text-muted-foreground" title={state.outputPath}>
          → {state.outputPath}
        </span>
      )}
      {state.error && (
        <span className="truncate font-mono" title={state.error}>
          {state.error}
        </span>
      )}
      {(state.status === "complete" ||
        state.status === "error" ||
        state.status === "cancelled") && (
        <button
          type="button"
          onClick={onReset}
          className="ml-auto rounded-md border border-input bg-background px-2 py-0.5 text-xs hover:bg-accent"
        >
          Dismiss
        </button>
      )}
    </div>
  );
}
