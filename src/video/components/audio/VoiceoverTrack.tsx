import React from "react";
import { Audio, Sequence, useVideoConfig } from "remotion";
import { staticFile } from "remotion";
import {
  buildVoiceoverTimeline,
  type VoiceoverManifest,
} from "../../lib/audio-timeline";

interface VoiceoverTrackProps {
  voiceoverManifest: VoiceoverManifest;
  volume?: number;
  gapFrames?: number;
}

export const VoiceoverTrack: React.FC<VoiceoverTrackProps> = ({
  voiceoverManifest,
  volume = 1.0,
  gapFrames = 15,
}) => {
  const { fps } = useVideoConfig();
  const timeline = buildVoiceoverTimeline(voiceoverManifest, fps, gapFrames);

  return (
    <>
      {timeline.map((entry) => (
        <Sequence
          key={entry.sectionId}
          from={entry.startFrame}
          durationInFrames={entry.endFrame - entry.startFrame}
        >
          <Audio
            src={staticFile(`audio/${entry.file}`)}
            volume={volume}
          />
        </Sequence>
      ))}
    </>
  );
};
