import { createLazyFileRoute } from "@tanstack/react-router";
import { Film } from "lucide-react";

import { CompositionPicker } from "@/video/composition-picker";
import { getRegistry } from "@/video/registry";

export const Route = createLazyFileRoute("/video/")({
  component: VideoIndex,
});

function VideoIndex() {
  const compositions = getRegistry();

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border px-6 py-4">
        <div className="flex items-center gap-2">
          <Film className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Video</h1>
          <span className="text-sm text-muted-foreground">
            ({compositions.length})
          </span>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Remotion compositions ported from <code className="rounded bg-muted px-1 py-0.5 text-[11px]">royalti-video-engine</code>.
          Click one to preview and render.
        </p>
      </header>
      <div className="flex-1 overflow-auto px-6 py-4">
        <CompositionPicker compositions={compositions} />
      </div>
    </div>
  );
}
