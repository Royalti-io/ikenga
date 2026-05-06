/**
 * SmokeTest — minimal composition that exercises all Phase 1 foundation APIs.
 *
 * Two variants are registered:
 *   SmokeTest-Hifi  — default dark teal palette (production look)
 *   SmokeTest-Lofi  — wireframe grayscale palette (Rung 1 lo-fi look)
 *
 * Exercises:
 *   defineBeats()            — beat timeline with validation
 *   defineComposition()      — self-registration
 *   <BrandProvider>          — palette context with lofi variant
 *   <StoryboardProvider>     — beat + narration metadata context
 *   usePalette()             — reads palette inside component
 *   useStoryboard()          — reads beat metadata inside component
 *   useNarrationSync()       — word-to-frame lookup (no audio required)
 *
 * No primitives from Phase 2 are used here — just AbsoluteFill + plain divs
 * so the smoke test has zero dependency on unfinished work.
 */

import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";

import { BrandProvider, usePalette } from "../../remotion-ui/themes/BrandProvider";
import { StoryboardProvider, useStoryboard } from "../../remotion-ui/themes/StoryboardProvider";
import { defaultPalette, lofiPalette } from "../../remotion-ui/themes/brand";
import { defineBeats } from "../../lib/define-beats";
import { defineComposition } from "../../lib/define-composition";
import { useNarrationSync } from "../../lib/use-narration-sync";
import { fontFamily } from "../../config/fonts";

// ── Beat timeline (shared by both variants) ────────────────────────────────

const smokeBeats = defineBeats(
  [
    {
      id: "hello",
      label: "Hello",
      time: { start: 0, end: 1.5 },
      narration_excerpt: "Hello, world.",
      intent: "Simple opening beat — test that the palette renders correctly.",
    },
    {
      id: "palette",
      label: "Palette",
      time: { start: 1.5, end: 3.0 },
      narration_excerpt: "Testing palette.",
      intent: "Show accent and highlight colours.",
    },
    {
      id: "done",
      label: "Done",
      time: { start: 3.0, end: 4.0 },
      narration_excerpt: "Foundation smoke test complete.",
      intent: "Final beat — composition ends here.",
    },
  ],
  { fps: 30 },
);

// ── Minimal narration manifest for useNarrationSync test ──────────────────

const smokeNarration = {
  audio: "",
  words: [
    { word: "Hello", start: 0.1, end: 0.4 },
    { word: "world", start: 0.5, end: 0.9 },
    { word: "Testing", start: 1.6, end: 2.0 },
    { word: "palette", start: 2.1, end: 2.6 },
    { word: "Foundation", start: 3.1, end: 3.7 },
    { word: "smoke", start: 3.7, end: 3.9 },
    { word: "test", start: 3.9, end: 4.0 },
    { word: "complete", start: 4.0, end: 4.1 },
  ],
};

// ── Inner component (uses hooks) ───────────────────────────────────────────

const SmokeInner: React.FC<{ slug: string }> = ({ slug }) => {
  const palette = usePalette();
  const storyboard = useStoryboard();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // useNarrationSync demo — compute the frame for the word "Testing"
  const sync = useNarrationSync({ words: smokeNarration.words, fps });
  const testingFrame = sync.frameForWord("Testing");

  // Determine active beat label
  const currentSec = frame / fps;
  const activeBeat = storyboard.beats.find(
    (b) => currentSec >= b.time.start && currentSec < b.time.end,
  );

  return (
    <AbsoluteFill
      style={{
        backgroundColor: palette.bg,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 28,
        padding: 80,
      }}
    >
      {/* Title */}
      <div
        style={{
          fontFamily,
          fontSize: 72,
          fontWeight: 700,
          color: palette.highlight,
          letterSpacing: "-0.03em",
          textAlign: "center",
        }}
      >
        {palette.lofi ? "LO-FI WIREFRAME" : "HI-FI"}
      </div>

      {/* Slug badge */}
      <div
        style={{
          backgroundColor: palette.surface,
          border: `1px solid ${palette.border}`,
          borderRadius: 12,
          padding: "10px 24px",
          fontFamily,
          fontSize: 28,
          fontWeight: 600,
          color: palette.textSec,
        }}
      >
        {slug}
      </div>

      {/* Active beat */}
      <div
        style={{
          fontFamily,
          fontSize: 36,
          fontWeight: 600,
          color: palette.textPri,
        }}
      >
        Beat: {activeBeat?.label ?? "—"}
      </div>

      {/* Narration sync probe */}
      <div
        style={{
          fontFamily,
          fontSize: 24,
          fontWeight: 500,
          color: palette.textSec,
        }}
      >
        "Testing" @ frame {testingFrame ?? "?"}
      </div>

      {/* Glow ring — suppressed in lofi mode */}
      {!palette.lofi && (
        <div
          style={{
            width: 120,
            height: 120,
            borderRadius: 60,
            backgroundColor: palette.accent,
            boxShadow: `0 0 60px ${palette.accent}88`,
            marginTop: 16,
          }}
        />
      )}

      {/* Lofi mode: plain filled circle instead */}
      {palette.lofi && (
        <div
          style={{
            width: 120,
            height: 120,
            borderRadius: 60,
            backgroundColor: palette.accent,
            marginTop: 16,
          }}
        />
      )}
    </AbsoluteFill>
  );
};

// ── Hi-fi composition ──────────────────────────────────────────────────────

export const SmokeTestHifi: React.FC = () => (
  <BrandProvider palette={defaultPalette}>
    <StoryboardProvider
      slug="smoke-test-hifi"
      beats={smokeBeats}
      narration={smokeNarration}
    >
      <SmokeInner slug="smoke-test-hifi" />
    </StoryboardProvider>
  </BrandProvider>
);

// ── Lo-fi composition ──────────────────────────────────────────────────────

export const SmokeTestLofi: React.FC = () => (
  <BrandProvider palette={lofiPalette}>
    <StoryboardProvider
      slug="smoke-test-lofi"
      beats={smokeBeats}
      narration={smokeNarration}
    >
      <SmokeInner slug="smoke-test-lofi" />
    </StoryboardProvider>
  </BrandProvider>
);

// ── Registration ───────────────────────────────────────────────────────────

const SMOKE_DURATION = Math.floor(4.0 * 30); // 4 seconds × 30fps = 120 frames

defineComposition({
  id: "SmokeTest-Hifi",
  component: SmokeTestHifi,
  fps: 30,
  width: 1080,
  height: 1920,
  durationInFrames: SMOKE_DURATION,
  defaultProps: {},
  beats: smokeBeats,
  folder: "Dev",
});

defineComposition({
  id: "SmokeTest-Lofi",
  component: SmokeTestLofi,
  fps: 30,
  width: 1080,
  height: 1920,
  durationInFrames: SMOKE_DURATION,
  defaultProps: {},
  beats: smokeBeats,
  folder: "Dev",
});
