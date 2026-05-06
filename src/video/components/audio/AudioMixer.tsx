import React, { useMemo } from "react";
import { AbsoluteFill, useVideoConfig } from "remotion";
import {
  buildVoiceoverTimeline,
  type TimelineEntry,
  type VoiceoverManifest,
} from "../../lib/audio-timeline";
import { BackgroundMusic } from "./BackgroundMusic";
import { SfxTrigger } from "./SfxTrigger";
import { VoiceoverTrack } from "./VoiceoverTrack";

export interface SfxCue {
  sfxName: string;
  startFrame: number;
  volume?: number;
}

interface AudioMixerProps {
  voiceoverManifest?: VoiceoverManifest;
  musicFile?: string;
  sfxCues?: SfxCue[];
  musicVolume?: number;
  voiceoverVolume?: number;
  totalDurationFrames: number;
}

export const AudioMixer: React.FC<AudioMixerProps> = ({
  voiceoverManifest,
  musicFile,
  sfxCues,
  musicVolume,
  voiceoverVolume,
  totalDurationFrames,
}) => {
  const { fps } = useVideoConfig();

  // Build the shared voiceover timeline once for ducking
  const voiceTimeline: TimelineEntry[] = useMemo(() => {
    if (!voiceoverManifest) return [];
    return buildVoiceoverTimeline(voiceoverManifest, fps);
  }, [voiceoverManifest, fps]);

  return (
    <AbsoluteFill>
      {musicFile && (
        <BackgroundMusic
          musicFile={musicFile}
          baseVolume={musicVolume}
          voiceTimeline={voiceTimeline}
          totalDurationFrames={totalDurationFrames}
        />
      )}
      {voiceoverManifest && (
        <VoiceoverTrack
          voiceoverManifest={voiceoverManifest}
          volume={voiceoverVolume}
        />
      )}
      {sfxCues?.map((cue, index) => (
        <SfxTrigger
          key={`${cue.sfxName}-${cue.startFrame}-${index}`}
          sfxName={cue.sfxName}
          startFrame={cue.startFrame}
          volume={cue.volume}
          voiceTimeline={voiceTimeline}
        />
      ))}
    </AbsoluteFill>
  );
};
