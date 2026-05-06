import { Link } from "@tanstack/react-router";
import { Film } from "lucide-react";

import type { CompositionDefinition } from "./lib/define-composition";

interface CompositionPickerProps {
  compositions: CompositionDefinition[];
}

export function CompositionPicker({ compositions }: CompositionPickerProps) {
  if (compositions.length === 0) {
    return (
      <div className="flex h-32 items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
        No compositions registered.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <table className="w-full text-sm">
        <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="px-3 py-2 text-left font-medium">Composition</th>
            <th className="px-3 py-2 text-left font-medium">Dimensions</th>
            <th className="px-3 py-2 text-left font-medium">Duration</th>
            <th className="px-3 py-2 text-left font-medium">Beats</th>
          </tr>
        </thead>
        <tbody>
          {compositions.map((c) => {
            const seconds = c.durationInFrames / c.fps;
            return (
              <tr
                key={c.id}
                className="cursor-pointer border-t border-border hover:bg-accent/50"
              >
                <td className="px-3 py-2">
                  <Link
                    to="/video/$compositionId"
                    params={{ compositionId: c.id }}
                    className="flex items-center gap-2 font-medium text-foreground hover:underline"
                  >
                    <Film className="h-4 w-4 text-muted-foreground" />
                    {c.id}
                  </Link>
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  {c.width}×{c.height}
                </td>
                <td className="px-3 py-2 text-xs tabular-nums text-muted-foreground">
                  {seconds.toFixed(1)}s · {c.durationInFrames}f @ {c.fps}fps
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  {c.beats?.length ?? 0}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
