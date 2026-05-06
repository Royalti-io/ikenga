import React from "react";
import { Audio, interpolate } from "remotion";
import { staticFile } from "remotion";
import { type TimelineEntry } from "../../lib/audio-timeline";
import {
  buildDuckingSchedule,
  getVolumeAtFrame,
  type DuckingSchedule,
} from "../../lib/audio-ducking";
import {
  DUCKING_TRANSITION_FRAMES,
  MUSIC_VOLUME,
  DUCKED_VOLUME,
} from "../../config/defaults";

interface BackgroundMusicProps {
  musicFile: string;
  baseVolume?: number;
  duckedVolume?: number;
  fadeInFrames?: number;
  fadeOutFrames?: number;
  voiceTimeline?: TimelineEntry[];
  totalDurationFrames: number;
}

export const BackgroundMusic: React.FC<BackgroundMusicProps> = ({
  musicFile,
  baseVolume = MUSIC_VOLUME,
  duckedVolume = DUCKED_VOLUME,
  fadeInFrames = 30,
  fadeOutFrames = 45,
  voiceTimeline,
  totalDurationFrames,
}) => {
  // Pre-compute ducking schedule once
  const schedule: DuckingSchedule = React.useMemo(
    () => buildDuckingSchedule(voiceTimeline ?? [], DUCKING_TRANSITION_FRAMES),
    [voiceTimeline],
  );

  const volumeCallback = React.useCallback(
    (frame: number) => {
      // 1. Fade-in ramp
      const fadeIn = interpolate(
        frame,
        [0, fadeInFrames],
        [0, baseVolume],
        { extrapolateRight: "clamp" },
      );

      // 2. Fade-out ramp
      const fadeOutStart = totalDurationFrames - fadeOutFrames;
      const fadeOut =
        frame >= fadeOutStart
          ? interpolate(
              frame,
              [fadeOutStart, totalDurationFrames],
              [1, 0],
              { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
            )
          : 1;

      // 3. Ducking via pre-computed schedule
      const duckingVolume = getVolumeAtFrame(frame, schedule, baseVolume, duckedVolume);

      // During fade-in, use the fade-in value; otherwise use ducking volume
      const envelopeVolume = frame < fadeInFrames ? fadeIn : duckingVolume;

      // Apply fade-out multiplier
      return envelopeVolume * fadeOut;
    },
    [baseVolume, duckedVolume, fadeInFrames, fadeOutFrames, totalDurationFrames, schedule],
  );

  return (
    <Audio
      src={staticFile(musicFile)}
      volume={volumeCallback}
      loop
    />
  );
};
