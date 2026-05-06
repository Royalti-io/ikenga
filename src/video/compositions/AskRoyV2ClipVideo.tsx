/**
 * AskRoyV2ClipVideo — 1080×1920 social clip for Royalti's "Ask Roy" feature, v2.
 *
 * Concept lock (from compositions/ask-roy-v2/storyboard.json):
 *   - editorial (frame)        → hook, pain, cta
 *   - conversational (chat)    → demo, trust
 *   - pivot is the seam (editorial → chat)
 *
 * Visual arc: editorial gravitas → page-turn into chat surface → editorial back-cover.
 *
 * This file is the Rung 1 lo-fi scaffold. Hook is the first beat fully
 * implemented; the other 5 are minimal placeholders that render a labelled
 * card so the composition compiles and the storyboard app can iterate
 * one beat at a time via `/video-bespoke continue ask-roy-v2`.
 *
 * Beats (44s @ 30fps = 1320 frames):
 *   1. hook    0 – 4    Editorial pull-quote
 *   2. pain    4 – 12   Editorial two-column lede + 20-min stat callout
 *   3. pivot  12 – 18   Page-turn into chat surface (load-bearing seam)
 *   4. demo   18 – 26   Chat surface — type-on question + answer + breakdown
 *   5. trust  26 – 36   Citation tray with editorial-flavored cards
 *   6. cta    36 – 44   Editorial back-cover + pill button
 */

import React from "react";
import {
  AbsoluteFill,
  Sequence,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
} from "remotion";
import { z } from "zod";

import { fontFamily } from "@/video/config/fonts";
import { defineBeats } from "@/video/lib/define-beats";
import { defineComposition } from "@/video/lib/define-composition";
import {
  BrandProvider,
  usePalette,
} from "@/video/remotion-ui/themes/BrandProvider";
import {
  StoryboardProvider,
  useStoryboard,
} from "@/video/remotion-ui/themes/StoryboardProvider";
import type { BrandPaletteWithMode } from "@/video/remotion-ui/themes/brand";
import { settle, bloom, lag, applyOffset } from "@/video/motion";

// ── Brand palette (v2 editorial dark Royalti) ─────────────────────────────
//
// Differs from v1's "royal-dark" cyan-leaning teal. v2 uses the canonical
// 2026 brand teal (#1a8d8d) with cooler blacks and a cleaner highlight.

const askRoyV2Palette: BrandPaletteWithMode = {
  bg: "#0d0f12",        // paper-dark
  surface: "#1a1d24",   // card surface
  border: "#2a2e36",    // hairline
  accent: "#1a8d8d",    // brand teal
  highlight: "#5ee5e5", // accent text / glow
  accent2: "#006666",   // deep teal — used sparingly for the pill button
  textPri: "#f3f3f4",
  textSec: "#9aa1ad",
};

// ── Beat timeline (single source of truth, mirrors storyboard.json) ───────

export const askRoyV2Beats = defineBeats(
  [
    { id: "hook",  label: "Hook",  time: { start:  0, end:  4 } },
    { id: "pain",  label: "Pain",  time: { start:  4, end: 12 } },
    { id: "pivot", label: "Pivot", time: { start: 12, end: 18 } },
    { id: "demo",  label: "Demo",  time: { start: 18, end: 26 } },
    { id: "trust", label: "Trust", time: { start: 26, end: 36 } },
    { id: "cta",   label: "CTA",   time: { start: 36, end: 44 } },
  ],
  { fps: 30 },
);

const TOTAL_FRAMES = 1320;
const XFADE_FRAMES = 10;

// ── Schema ────────────────────────────────────────────────────────────────

export const askRoyV2ClipVideoSchema = z.object({
  /** Render rung — "1_lofi" forces wireframe palette for fast still generation. */
  renderRung: z.enum(["1_lofi", "2_hifi"]).default("2_hifi"),
});

export type AskRoyV2ClipVideoProps = z.infer<typeof askRoyV2ClipVideoSchema>;

// ── Utility: scene-level fade envelope ────────────────────────────────────

function envelope(frame: number, duration: number): number {
  const fadeIn = interpolate(frame, [0, XFADE_FRAMES], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const fadeOut = interpolate(
    frame,
    [duration - XFADE_FRAMES, duration],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );
  return Math.min(fadeIn, fadeOut);
}

// ── Editorial chrome (brand row + issue mark) ─────────────────────────────
//
// Shared across all editorial beats (hook, pain, cta). Persistent typographic
// chrome — the subtle cue that we're inside a magazine. Lofi-safe: pure
// monochrome small-caps mono.

const EditorialChrome: React.FC<{ alpha: number }> = ({ alpha }) => {
  const palette = usePalette();
  const baseStyle: React.CSSProperties = {
    position: "absolute",
    top: 60,
    fontFamily: "JetBrains Mono, Menlo, monospace",
    fontSize: 22,
    fontWeight: 500,
    letterSpacing: "0.18em",
    textTransform: "uppercase",
    color: palette.textSec,
    opacity: alpha * 0.6,
  };
  return (
    <>
      {/* Top-left: brand row */}
      <div
        style={{
          ...baseStyle,
          left: 60,
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        <span
          style={{
            display: "inline-block",
            width: 14,
            height: 14,
            borderRadius: 7,
            backgroundColor: palette.accent,
          }}
        />
        Royalti.io · Ask Roy
      </div>
      {/* Top-right: issue mark */}
      <div
        style={{
          ...baseStyle,
          right: 60,
          textAlign: "right",
        }}
      >
        Issue 04 · 2026
      </div>
    </>
  );
};

// ── Beat 1: Hook (editorial pull-quote) ───────────────────────────────────
//
// Spec (Rung 0):
//   Single typographic moment. Massive sans-serif headline, weight 800,
//   letter-spacing -0.035em, line-height 1.0, max-width 920px. Word
//   "answers" in palette.accent (teal). Editorial chrome: brand row +
//   issue mark. No chat UI.
//
// Motion:
//   - Container alpha settles in by frame 6 (~200ms)
//   - Pre-line "Your royalty data already has" lays in by frame ~30
//   - Hero word "answers" blooms in (scale 0.92→1.00, opacity 0→1) by frame ~50
//
// Note: visual reveal completes by ~frame 60 (mid-beat) so the still
// captures the fully-composed state. Narration timing is independent —
// captions sync via CaptionBar at Rung 2.

const HookScene: React.FC = () => {
  const palette = usePalette();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const beat = askRoyV2Beats[0]!;
  const duration = beat.frames!.end - beat.frames!.start;
  const alpha = envelope(frame, duration);

  // Reveal cadence — composition-relative since this is inside its Sequence.
  const preStart = applyOffset(0, lag(150), fps);   // ~5 frames
  const heroStart = applyOffset(0, lag(900), fps);  // ~27 frames

  const preP = settle({ frame, fps, startAt: preStart });
  const heroP = bloom({ frame, fps, startAt: heroStart });
  const heroScale = interpolate(Math.min(heroP, 1), [0, 1], [0.92, 1]);

  // Hi-fi: subtle teal halo behind the hero word. Lofi: suppressed.
  const heroShadow = palette.lofi
    ? "none"
    : `0 0 80px ${palette.accent}55, 0 0 160px ${palette.accent}22`;

  return (
    <AbsoluteFill
      style={{
        backgroundColor: palette.bg,
        opacity: alpha,
      }}
    >
      <EditorialChrome alpha={alpha} />

      {/* Centered headline */}
      <AbsoluteFill
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: "0 80px",
          gap: 20,
        }}
      >
        <div
          style={{
            fontFamily,
            fontSize: 110,
            fontWeight: 800,
            color: palette.textPri,
            textAlign: "center",
            lineHeight: 1.0,
            letterSpacing: "-0.035em",
            maxWidth: 920,
            opacity: preP,
            transform: `translateY(${interpolate(preP, [0, 1], [16, 0])}px)`,
          }}
        >
          Your royalty data
          <br />
          already has{" "}
          <span
            style={{
              display: "inline-block",
              color: palette.accent,
              opacity: Math.min(heroP, 1),
              transform: `scale(${heroScale})`,
              transformOrigin: "left center",
              textShadow: heroShadow,
            }}
          >
            answers.
          </span>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

// ── Stub beats (Rung 1 placeholders — implemented one at a time) ──────────
//
// Each stub renders a centered card showing the beat label, time range, and
// a "PENDING" tag. The composition compiles cleanly; the storyboard app can
// render a still per beat that shows we're at lo-fi-stub state. Each beat
// graduates to a real implementation in its own /video-bespoke pass.

const PendingBeatStub: React.FC<{
  beatIdx: number;
  description: string;
}> = ({ beatIdx, description }) => {
  const palette = usePalette();
  const frame = useCurrentFrame();
  const beat = askRoyV2Beats[beatIdx]!;
  const duration = beat.frames!.end - beat.frames!.start;
  const alpha = envelope(frame, duration);

  return (
    <AbsoluteFill
      style={{
        backgroundColor: palette.bg,
        opacity: alpha,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: 80,
      }}
    >
      <div
        style={{
          fontFamily: "JetBrains Mono, Menlo, monospace",
          fontSize: 24,
          letterSpacing: "0.18em",
          textTransform: "uppercase",
          color: palette.textSec,
          marginBottom: 24,
        }}
      >
        Beat {beatIdx + 1} · {beat.id} · {beat.time.start}–{beat.time.end}s
      </div>
      <div
        style={{
          fontFamily,
          fontSize: 84,
          fontWeight: 700,
          color: palette.textPri,
          letterSpacing: "-0.03em",
          marginBottom: 32,
        }}
      >
        {beat.label}
      </div>
      <div
        style={{
          fontFamily,
          fontSize: 26,
          fontWeight: 500,
          color: palette.textSec,
          textAlign: "center",
          maxWidth: 760,
          lineHeight: 1.5,
        }}
      >
        {description}
      </div>
      <div
        style={{
          marginTop: 60,
          padding: "10px 22px",
          borderRadius: 999,
          border: `2px solid ${palette.border}`,
          fontFamily: "JetBrains Mono, Menlo, monospace",
          fontSize: 18,
          letterSpacing: "0.2em",
          textTransform: "uppercase",
          color: palette.textSec,
        }}
      >
        Rung 1 · pending
      </div>
    </AbsoluteFill>
  );
};

const PainScene: React.FC = () => (
  <PendingBeatStub
    beatIdx={1}
    description="Two-column editorial spread: serif lede + 20 min stat callout + 'csv ✗ dashboard ✗ formula ✗' annotation row."
  />
);
const PivotScene: React.FC = () => (
  <PendingBeatStub
    beatIdx={2}
    description="Page-turn from editorial spread → chat surface composed within editorial grid. Roy avatar bloom locked to 'ask?' + 200ms."
  />
);
const DemoScene: React.FC = () => (
  <PendingBeatStub
    beatIdx={3}
    description="Type-on user bubble → typing dots → big teal $24,318.42 → Oct/Nov/Dec breakdown grid. 'view source →' affordance seeds Trust."
  />
);
const TrustScene: React.FC = () => (
  <PendingBeatStub
    beatIdx={4}
    description="Citation tray hangs off Roy's reply. Three editorial-flavored cards reveal: CSV row · contract clause (serif italic on cream) · split donut."
  />
);
const CtaScene: React.FC = () => (
  <PendingBeatStub
    beatIdx={5}
    description="Editorial back-cover. Headline 'Open your dashboard. Ask Roy your first question.' + dashboard mockup right + pill button + Issue 04 callback."
  />
);

// ── Inner composition (uses palette + beats from context) ─────────────────

const AskRoyV2Inner: React.FC = () => {
  const palette = usePalette();
  const storyboard = useStoryboard();
  const [hook, pain, pivot, demo, trust, cta] = storyboard.beats;

  return (
    <AbsoluteFill style={{ backgroundColor: palette.bg }}>
      <Sequence
        from={hook.frames!.start}
        durationInFrames={hook.frames!.end - hook.frames!.start + XFADE_FRAMES}
      >
        <HookScene />
      </Sequence>
      <Sequence
        from={pain.frames!.start}
        durationInFrames={pain.frames!.end - pain.frames!.start + XFADE_FRAMES}
      >
        <PainScene />
      </Sequence>
      <Sequence
        from={pivot.frames!.start}
        durationInFrames={pivot.frames!.end - pivot.frames!.start + XFADE_FRAMES}
      >
        <PivotScene />
      </Sequence>
      <Sequence
        from={demo.frames!.start}
        durationInFrames={demo.frames!.end - demo.frames!.start + XFADE_FRAMES}
      >
        <DemoScene />
      </Sequence>
      <Sequence
        from={trust.frames!.start}
        durationInFrames={trust.frames!.end - trust.frames!.start + XFADE_FRAMES}
      >
        <TrustScene />
      </Sequence>
      <Sequence
        from={cta.frames!.start}
        durationInFrames={cta.frames!.end - cta.frames!.start}
      >
        <CtaScene />
      </Sequence>
    </AbsoluteFill>
  );
};

// ── Composition root ──────────────────────────────────────────────────────

export const AskRoyV2ClipVideo: React.FC<AskRoyV2ClipVideoProps> = ({
  renderRung,
}) => {
  const isLofi = renderRung === "1_lofi";
  return (
    <BrandProvider palette={askRoyV2Palette} lofi={isLofi}>
      <StoryboardProvider slug="ask-roy-v2" beats={askRoyV2Beats}>
        <AskRoyV2Inner />
      </StoryboardProvider>
    </BrandProvider>
  );
};

// ── Self-registration ─────────────────────────────────────────────────────

defineComposition({
  id: "AskRoyV2Clip",
  component: AskRoyV2ClipVideo,
  fps: 30,
  width: 1080,
  height: 1920,
  durationInFrames: TOTAL_FRAMES,
  defaultProps: {
    renderRung: "2_hifi",
  },
  beats: askRoyV2Beats,
  schema: askRoyV2ClipVideoSchema,
});
