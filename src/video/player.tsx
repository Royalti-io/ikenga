import { useMemo } from "react";
import { Player, type PlayerRef } from "@remotion/player";

import type { CompositionDefinition } from "./lib/define-composition";
import { ensureStaticBaseInstalled } from "./static-base";

interface VideoPlayerProps {
  composition: CompositionDefinition;
  inputProps: Record<string, unknown>;
  /** Constrain preview width in px. Height derives from composition aspect ratio. */
  maxWidth?: number;
  /** Forwarded to Remotion's Player so callers can scrub programmatically. */
  playerRef?: React.Ref<PlayerRef>;
}

export function VideoPlayer({
  composition,
  inputProps,
  maxWidth = 540,
  playerRef,
}: VideoPlayerProps) {
  ensureStaticBaseInstalled();

  // Scale preview to maxWidth while preserving aspect ratio.
  const { width, height } = useMemo(() => {
    const aspect = composition.height / composition.width;
    const w = Math.min(maxWidth, composition.width);
    return { width: w, height: w * aspect };
  }, [composition.width, composition.height, maxWidth]);

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-black">
      <Player
        ref={playerRef}
        component={composition.component}
        inputProps={inputProps}
        compositionWidth={composition.width}
        compositionHeight={composition.height}
        durationInFrames={composition.durationInFrames}
        fps={composition.fps}
        controls
        loop={false}
        style={{ width, height }}
      />
    </div>
  );
}
