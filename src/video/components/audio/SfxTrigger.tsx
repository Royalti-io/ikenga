import React from "react";
import { Audio, Sequence } from "remotion";
import { staticFile } from "remotion";
import { getSfxFile } from "../../lib/sfx-registry";
import { type TimelineEntry } from "../../lib/audio-timeline";
import {
  buildDuckingSchedule,
  getVolumeAtFrame,
  type DuckingSchedule,
} from "../../lib/audio-ducking";
import {
  DUCKING_TRANSITION_FRAMES,
  SFX_DUCKED_VOLUME,
} from "../../config/defaults";

interface SfxTriggerProps {
  sfxName: string;
  startFrame: number;
  volume?: number;
  voiceTimeline?: TimelineEntry[];
}

export const SfxTrigger: React.FC<SfxTriggerProps> = ({
  sfxName,
  startFrame,
  volume = 0.5,
  voiceTimeline,
}) => {
  const file = getSfxFile(sfxName);

  // Pre-compute ducking schedule once
  const schedule: DuckingSchedule = React.useMemo(
    () => buildDuckingSchedule(voiceTimeline ?? [], DUCKING_TRANSITION_FRAMES),
    [voiceTimeline],
  );

  const volumeCallback = React.useCallback(
    (relativeFrame: number) => {
      if (!voiceTimeline || voiceTimeline.length === 0) {
        return volume;
      }

      // Convert to absolute frame for schedule lookup
      const absoluteFrame = startFrame + relativeFrame;
      return getVolumeAtFrame(absoluteFrame, schedule, volume, SFX_DUCKED_VOLUME);
    },
    [startFrame, volume, voiceTimeline, schedule],
  );

  return (
    <Sequence from={startFrame}>
      <Audio
        src={staticFile(`sfx/${file}`)}
        volume={volumeCallback}
      />
    </Sequence>
  );
};
