/**
 * AskRoyClipVideo — 1080x1920 social clip for Royalti's "Ask Roy" feature.
 *
 * Phase 3 freeform exemplar. Migrated from the hand-rolled v2 to use:
 *   - BrandProvider + usePalette() (no raw hex colors in scenes)
 *   - StoryboardProvider + defineBeats() (single source of beat truth)
 *   - Motion vocabulary (settle/snap/bloom + lag/lead/applyOffset)
 *   - Primitives (Stat, RevealList, HighlightWords, KenBurns, Annotation,
 *                 ChatBubble, AvatarBadge, CaptionBar)
 *   - defineComposition() (no manual <Composition> JSX in Root.tsx)
 *
 * Six beats (timing in seconds):
 *   1. hook    0-3.808   Two-line headline
 *   2. problem 3.808-15.256  CSV / dashboard / formula reveal + 20 min stat
 *   3. reveal  15.256-24.857 Avatar badge + "Meet Ask Roy" + 126 tools pill
 *   4. demo    24.857-32.671 Three query bubbles staggered
 *   5. shot    32.671-38.697 Screenshot with KenBurns
 *   6. cta     38.697-44.7   Headline + Try Ask Roy button + URL
 *
 * The composition accepts `renderRung` so `npm run still:beat -- --rung lofi`
 * can produce wireframe stills without changing the source.
 */

import React from "react";
import {
  AbsoluteFill,
  Audio,
  Img,
  Sequence,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
} from "remotion";
import { z } from "zod";

import { fontFamily } from "@/video/config/fonts";
import { defineBeats } from "@/video/lib/define-beats";
import { defineComposition } from "@/video/lib/define-composition";
import { useNarrationSync } from "@/video/lib/use-narration-sync";
import {
  BrandProvider,
  usePalette,
} from "@/video/remotion-ui/themes/BrandProvider";
import {
  StoryboardProvider,
  useStoryboard,
} from "@/video/remotion-ui/themes/StoryboardProvider";
import type { BrandPaletteWithMode } from "@/video/remotion-ui/themes/brand";
import {
  Annotation,
  AvatarBadge,
  CaptionBar,
  ChatBubble,
  HighlightWords,
  KenBurns,
  RevealList,
  Stat,
  type CaptionPhrase,
} from "@/video/remotion-ui/primitives";
import { settle, snap, bloom, lag, applyOffset } from "@/video/motion";

// ── Brand palette (dark teal Ask Roy) ──────────────────────────────────────

const askRoyPalette: BrandPaletteWithMode = {
  bg: "#002626",       // royal-dark-100
  surface: "#003333",  // royal-dark-200
  border: "#004d4d",   // royal-dark-300
  accent: "#00807f",   // royal-dark-500
  highlight: "#66cccc",// royal-dark-800
  textPri: "#f0f5f5",
  textSec: "#b3c4c4",
};

// ── Beat timeline (single source of truth) ─────────────────────────────────

export const askRoyBeats = defineBeats(
  [
    { id: "hook",    label: "Hook",       time: { start: 0,      end: 3.808  } },
    { id: "problem", label: "Problem",    time: { start: 3.808,  end: 15.256 } },
    { id: "reveal",  label: "Reveal",     time: { start: 15.256, end: 24.857 } },
    { id: "demo",    label: "Demo",       time: { start: 24.857, end: 32.671 } },
    { id: "shot",    label: "Screenshot", time: { start: 32.671, end: 38.697 } },
    { id: "cta",     label: "CTA",        time: { start: 38.697, end: 44.7   } },
  ],
  { fps: 30 },
);

const TOTAL_FRAMES = 1341; // 44.7s * 30fps
const XFADE_FRAMES = 10;

// ── Schema ─────────────────────────────────────────────────────────────────

export const askRoyClipVideoSchema = z.object({
  narrationFile: z.string().default("ask-roy/narration.mp3"),
  screenshotFile: z.string().default("ask-roy/audit-story.png"),
  /** Render rung — "1_lofi" forces wireframe palette for fast still generation. */
  renderRung: z.enum(["1_lofi", "2_hifi"]).default("2_hifi"),
});

export type AskRoyClipVideoProps = z.infer<typeof askRoyClipVideoSchema>;

// ── Narration manifest (word-level timestamps from ElevenLabs) ────────────
// Inlined here for fast composition load. Single source of truth lives in
// compositions/ask-roy/storyboard.json — keep these in sync.

const askRoyNarration = {
  audio: "ask-roy/narration.mp3",
  words: [
    { word: "Your", start: 0, end: 0.221 },
    { word: "royalty", start: 0.255, end: 0.662 },
    { word: "data", start: 0.72, end: 1.01 },
    { word: "has", start: 1.057, end: 1.196 },
    { word: "answers.", start: 1.289, end: 1.904 },
    { word: "Asking", start: 2.148, end: 2.566 },
    { word: "was", start: 2.612, end: 2.728 },
    { word: "the", start: 2.775, end: 2.844 },
    { word: "hard", start: 2.902, end: 3.065 },
    { word: "part.", start: 3.123, end: 3.564 },
    { word: "That", start: 3.808, end: 4.005 },
    { word: "number", start: 4.075, end: 4.331 },
    { word: "your", start: 4.377, end: 4.481 },
    { word: "distributor", start: 4.528, end: 5.097 },
    { word: "owes", start: 5.166, end: 5.375 },
    { word: "you?", start: 5.445, end: 5.712 },
    { word: "It's", start: 5.956, end: 6.153 },
    { word: "buried", start: 6.235, end: 6.525 },
    { word: "between", start: 6.56, end: 6.838 },
    { word: "three", start: 6.908, end: 7.175 },
    { word: "CSV", start: 7.198, end: 7.546 },
    { word: "exports,", start: 7.663, end: 8.278 },
    { word: "two", start: 8.487, end: 8.684 },
    { word: "dashboards,", start: 8.742, end: 9.311 },
    { word: "and", start: 9.462, end: 9.625 },
    { word: "a", start: 9.671, end: 9.694 },
    { word: "formula", start: 9.776, end: 10.182 },
    { word: "you", start: 10.24, end: 10.321 },
    { word: "wrote", start: 10.368, end: 10.577 },
    { word: "six", start: 10.612, end: 10.82 },
    { word: "months", start: 10.902, end: 11.111 },
    { word: "ago.", start: 11.146, end: 11.54 },
    { word: "Finding", start: 11.865, end: 12.237 },
    { word: "it", start: 12.295, end: 12.365 },
    { word: "takes", start: 12.411, end: 12.632 },
    { word: "twenty", start: 12.666, end: 12.98 },
    { word: "minutes.", start: 13.038, end: 13.456 },
    { word: "Verifying", start: 13.7, end: 14.257 },
    { word: "takes", start: 14.304, end: 14.524 },
    { word: "longer.", start: 14.571, end: 15.012 },
    { word: "Meet", start: 15.256, end: 15.476 },
    { word: "Ask", start: 15.558, end: 15.813 },
    { word: "Roy.", start: 15.929, end: 16.312 },
    { word: "The", start: 16.486, end: 16.626 },
    { word: "AI", start: 16.684, end: 16.951 },
    { word: "assistant", start: 16.997, end: 17.508 },
    { word: "built", start: 17.566, end: 17.798 },
    { word: "into", start: 17.856, end: 18.054 },
    { word: "your", start: 18.123, end: 18.228 },
    { word: "Royalti", start: 18.274, end: 18.658 },
    { word: "dashboard,", start: 18.727, end: 19.319 },
    { word: "with", start: 19.493, end: 19.656 },
    { word: "a", start: 19.691, end: 19.726 },
    { word: "hundred", start: 19.795, end: 20.167 },
    { word: "and", start: 20.213, end: 20.295 },
    { word: "twenty-six", start: 20.341, end: 20.91 },
    { word: "tools", start: 20.98, end: 21.351 },
    { word: "that", start: 21.56, end: 21.781 },
    { word: "read", start: 21.897, end: 22.164 },
    { word: "and", start: 22.233, end: 22.373 },
    { word: "write", start: 22.442, end: 22.733 },
    { word: "across", start: 22.779, end: 23.151 },
    { word: "your", start: 23.197, end: 23.313 },
    { word: "entire", start: 23.36, end: 23.836 },
    { word: "workspace.", start: 23.882, end: 24.532 },
    { word: "Ask", start: 24.857, end: 25.148 },
    { word: "it", start: 25.206, end: 25.31 },
    { word: "anything.", start: 25.368, end: 25.891 },
    { word: "What", start: 26.134, end: 26.343 },
    { word: "Spotify", start: 26.692, end: 27.202 },
    { word: "Run", start: 28.689, end: 28.863 },
    { word: "Upload", start: 30.872, end: 31.29 },
    { word: "Roy", start: 32.671, end: 32.903 },
    { word: "Twenty-minute", start: 38.697, end: 39.382 },
    { word: "Open", start: 41.286, end: 41.564 },
    { word: "Roy", start: 42.888, end: 43.167 },
  ],
};

// ── Caption phrases (passed to <CaptionBar />) ─────────────────────────────

const CAPTIONS: CaptionPhrase[] = [
  { text: "Your royalty data has answers.", start: 0, end: 1.904 },
  { text: "Asking was the hard part.", start: 2.148, end: 3.564 },
  { text: "That number your distributor owes you?", start: 3.808, end: 5.712 },
  { text: "It's buried between three CSV exports,", start: 5.956, end: 8.278 },
  { text: "two dashboards, and a formula you", start: 8.487, end: 10.321 },
  { text: "wrote six months ago.", start: 10.368, end: 11.54 },
  { text: "Finding it takes twenty minutes.", start: 11.865, end: 13.456 },
  { text: "Verifying takes longer.", start: 13.7, end: 15.012 },
  { text: "Meet Ask Roy.", start: 15.256, end: 16.312 },
  { text: "The AI assistant built into your", start: 16.486, end: 18.228 },
  { text: "Royalti dashboard, with a hundred and", start: 18.274, end: 20.295 },
  { text: "twenty-six tools that read and write", start: 20.341, end: 22.733 },
  { text: "across your entire workspace.", start: 22.779, end: 24.532 },
  { text: "Ask it anything.", start: 24.857, end: 25.891 },
  { text: "What was my Spotify revenue last", start: 26.134, end: 27.888 },
  { text: "quarter?", start: 27.946, end: 28.445 },
  { text: "Run an audit on my catalog", start: 28.689, end: 30.14 },
  { text: "splits.", start: 30.187, end: 30.663 },
  { text: "Upload this DistroKid file.", start: 30.872, end: 32.462 },
  { text: "Roy reads your data, answers in", start: 32.671, end: 34.633 },
  { text: "seconds, and acts, with your confirmation", start: 34.726, end: 37.28 },
  { text: "every step of the way.", start: 37.396, end: 38.453 },
  { text: "Twenty-minute searches, one sentence.", start: 38.697, end: 41.042 },
  { text: "Open your dashboard and ask Roy", start: 41.286, end: 43.167 },
  { text: "your first question.", start: 43.341, end: 44.629 },
];

// ── Utility: scene-level fade envelope ─────────────────────────────────────

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

// ── Beat 1: Hook ───────────────────────────────────────────────────────────

const HookScene: React.FC = () => {
  const palette = usePalette();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const beat = askRoyBeats[0]!;
  const duration = beat.frames!.end - beat.frames!.start;
  const alpha = envelope(frame, duration);

  // Hero word "answers." blooms in as the visual anchor. Pre-line and
  // sub-line lag in around it — typographic drama replaces two stacked lines.
  const preStart = applyOffset(0, lag(150), fps);
  const heroStart = applyOffset(0, lag(450), fps);
  const subStart = applyOffset(0, lag(1500), fps);

  const preP = settle({ frame, fps, startAt: preStart });
  const heroP = bloom({ frame, fps, startAt: heroStart });
  const subP = settle({ frame, fps, startAt: subStart });

  const heroScale = interpolate(Math.min(heroP, 1), [0, 1], [0.7, 1]);

  return (
    <AbsoluteFill
      style={{
        backgroundColor: palette.bg,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: 80,
        opacity: alpha,
      }}
    >
      <div
        style={{
          fontFamily,
          fontSize: 38,
          fontWeight: 500,
          color: palette.textSec,
          textAlign: "center",
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          opacity: preP,
          transform: `translateY(${interpolate(preP, [0, 1], [12, 0])}px)`,
        }}
      >
        Your royalty data already has
      </div>
      <div
        style={{
          fontFamily,
          fontSize: 220,
          fontWeight: 800,
          color: palette.highlight,
          textAlign: "center",
          lineHeight: 0.95,
          letterSpacing: "-0.05em",
          marginTop: 18,
          opacity: Math.min(heroP, 1),
          transform: `scale(${heroScale})`,
          textShadow: palette.lofi ? "none" : `0 0 80px ${palette.highlight}55`,
        }}
      >
        answers.
      </div>
      <div
        style={{
          fontFamily,
          fontSize: 44,
          fontWeight: 500,
          color: palette.textSec,
          marginTop: 60,
          textAlign: "center",
          opacity: subP,
          transform: `translateY(${interpolate(subP, [0, 1], [20, 0])}px)`,
        }}
      >
        <HighlightWords text="Asking was the hard part" words={["Asking"]} bold={false} />.
      </div>
    </AbsoluteFill>
  );
};

// ── Beat 2: Problem ────────────────────────────────────────────────────────

const ProblemScene: React.FC = () => {
  const palette = usePalette();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const beat = askRoyBeats[1]!;
  const beatStart = beat.frames!.start;
  const duration = beat.frames!.end - beatStart;
  const alpha = envelope(frame, duration);

  // Use narration sync to anchor reveals to spoken words. All frames are
  // ABSOLUTE composition frames — convert to scene-relative for primitives
  // by subtracting beatStart.
  const sync = useNarrationSync({ words: askRoyNarration.words, fps });
  const csvFrame  = (sync.frameForWord("CSV")        ?? beatStart + 65)  - beatStart;
  const dashFrame = (sync.frameForWord("dashboards") ?? beatStart + 141) - beatStart;
  const formFrame = (sync.frameForWord("formula")    ?? beatStart + 180) - beatStart;
  const statFrame = (sync.frameForWord("Finding")    ?? beatStart + 242) - beatStart;
  const statStart = applyOffset(statFrame, lag(0), fps);

  const subheadP = settle({ frame, fps });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: palette.bg,
        opacity: alpha,
        padding: 60,
        paddingTop: 140,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "flex-start",
        gap: 28,
      }}
    >
      <div
        style={{
          fontFamily,
          fontSize: 42,
          fontWeight: 700,
          color: palette.textPri,
          marginBottom: 24,
          textAlign: "center",
          maxWidth: "84%",
          lineHeight: 1.3,
          letterSpacing: "-0.02em",
          opacity: subheadP,
        }}
      >
        To answer <HighlightWords text="one" words={["one"]} bold={false} /> question, you open:
      </div>

      <div style={{ width: "82%" }}>
        <RevealList
          gap={20}
          items={[
            {
              revealAtFrame: csvFrame,
              icon: "📊",
              content: (
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span style={{ fontSize: 36, fontWeight: 700, letterSpacing: "-0.01em" }}>
                    3 CSV exports
                  </span>
                  <span style={{ fontSize: 22, fontWeight: 500, color: palette.textSec }}>
                    One per distributor
                  </span>
                </div>
              ),
            },
            {
              revealAtFrame: dashFrame,
              icon: "🖥️",
              content: (
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span style={{ fontSize: 36, fontWeight: 700, letterSpacing: "-0.01em" }}>
                    2 dashboards
                  </span>
                  <span style={{ fontSize: 22, fontWeight: 500, color: palette.textSec }}>
                    Neither shows the whole picture
                  </span>
                </div>
              ),
            },
            {
              revealAtFrame: formFrame,
              icon: "📐",
              content: (
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span style={{ fontSize: 36, fontWeight: 700, letterSpacing: "-0.01em" }}>
                    1 formula
                  </span>
                  <span style={{ fontSize: 22, fontWeight: 500, color: palette.textSec }}>
                    Written 6 months ago, forgotten
                  </span>
                </div>
              ),
            },
          ]}
        />
      </div>

      <div style={{ marginTop: 48 }}>
        <Stat
          value="20 min"
          label="to find one number"
          size="lg"
          startAt={statStart}
        />
      </div>

      <Annotation
        target={{ x: 0.5, y: 0.82, fraction: true }}
        side="right"
        text="every. single. time."
        arrow="curve"
        distance={140}
        startAt={applyOffset(statFrame, lag(600), fps)}
      />
    </AbsoluteFill>
  );
};

// ── Beat 3: Reveal ─────────────────────────────────────────────────────────

const RevealScene: React.FC = () => {
  const palette = usePalette();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const beat = askRoyBeats[2]!;
  const beatStart = beat.frames!.start;
  const duration = beat.frames!.end - beatStart;
  const alpha = envelope(frame, duration);

  const sync = useNarrationSync({ words: askRoyNarration.words, fps });
  // "Meet" anchors headline; "twenty-six" anchors the stat pill.
  const meetFrame = (sync.frameForWord("Meet")       ?? beatStart) - beatStart;
  const tsixFrame = (sync.frameForWord("twenty-six") ?? beatStart + 151) - beatStart;
  const badgeStart = applyOffset(meetFrame, lag(2800), fps); // badge lags into reveal
  const headStart  = applyOffset(meetFrame, lag(100), fps);
  const statStart  = applyOffset(tsixFrame, lag(0), fps);

  const headP = snap({ frame, fps, startAt: headStart });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: palette.bg,
        opacity: alpha,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 32,
        padding: 80,
      }}
    >
      <AvatarBadge glyph="R" size={160} startAt={badgeStart} />

      <div
        style={{
          fontFamily,
          fontSize: 108,
          fontWeight: 700,
          color: palette.textPri,
          textAlign: "center",
          lineHeight: 1.05,
          letterSpacing: "-0.035em",
          opacity: headP,
          transform: `translateY(${interpolate(headP, [0, 1], [30, 0])}px)`,
        }}
      >
        Meet <HighlightWords text="Ask Roy" words={["Ask Roy"]} bold={false} />.
      </div>

      <div style={{ marginTop: 20 }}>
        <Stat
          value="126"
          label="read + write across your workspace"
          subline="tools"
          size="md"
          startAt={statStart}
        />
      </div>
    </AbsoluteFill>
  );
};

// ── Beat 4: Demo ───────────────────────────────────────────────────────────

const DemoScene: React.FC = () => {
  const palette = usePalette();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const beat = askRoyBeats[3]!;
  const beatStart = beat.frames!.start;
  const duration = beat.frames!.end - beatStart;
  const alpha = envelope(frame, duration);

  const headP = snap({ frame, fps });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: palette.bg,
        opacity: alpha,
        padding: 60,
        paddingTop: 150,
        display: "flex",
        flexDirection: "column",
        gap: 22,
      }}
    >
      <div
        style={{
          fontFamily,
          fontSize: 42,
          fontWeight: 700,
          color: palette.textPri,
          marginBottom: 20,
          textAlign: "center",
          letterSpacing: "-0.02em",
          opacity: headP,
        }}
      >
        Ask it <HighlightWords text="anything" words={["anything"]} bold={false} />.
      </div>

      <ChatBubble side="right" tone="user" revealAtWord="Spotify">
        What was my Spotify revenue last quarter?
      </ChatBubble>
      <ChatBubble side="right" tone="user" revealAtWord="Run">
        Run an audit on my catalog splits.
      </ChatBubble>
      <ChatBubble side="right" tone="user" revealAtWord="Upload">
        Upload this DistroKid file.
      </ChatBubble>
    </AbsoluteFill>
  );
};

// ── Beat 5: Screenshot ─────────────────────────────────────────────────────

const ScreenshotScene: React.FC<{ screenshotFile: string }> = ({
  screenshotFile,
}) => {
  const palette = usePalette();
  const frame = useCurrentFrame();
  const beat = askRoyBeats[4]!;
  const duration = beat.frames!.end - beat.frames!.start;
  const alpha = envelope(frame, duration);

  // Bottom-darkening overlay reads the palette so it stays in-brand.
  const overlay = palette.lofi
    ? "transparent"
    : `linear-gradient(180deg, ${palette.bg}00 55%, ${palette.bg}c0 100%)`;

  return (
    <AbsoluteFill style={{ backgroundColor: palette.bg, opacity: alpha }}>
      <KenBurns from={1.08} to={1.0} duration={6} origin="center">
        <Img
          src={staticFile(screenshotFile)}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      </KenBurns>
      <AbsoluteFill style={{ background: overlay }} />
    </AbsoluteFill>
  );
};

// ── Beat 6: CTA ────────────────────────────────────────────────────────────

const CtaScene: React.FC = () => {
  const palette = usePalette();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const beat = askRoyBeats[5]!;
  const duration = beat.frames!.end - beat.frames!.start;
  const alpha = envelope(frame, duration);

  const headP = settle({ frame, fps });
  const btnP  = bloom({ frame, fps, startAt: applyOffset(0, lag(1200), fps) });
  const urlP  = settle({ frame, fps, startAt: applyOffset(0, lag(2000), fps) });

  const btnGlow = palette.lofi ? "none" : `0 0 50px ${palette.highlight}55`;

  return (
    <AbsoluteFill
      style={{
        backgroundColor: palette.bg,
        opacity: alpha,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 40,
        padding: 80,
      }}
    >
      <div
        style={{
          fontFamily,
          fontSize: 64,
          fontWeight: 700,
          color: palette.textPri,
          textAlign: "center",
          lineHeight: 1.15,
          letterSpacing: "-0.02em",
          opacity: headP,
          transform: `translateY(${interpolate(headP, [0, 1], [20, 0])}px)`,
        }}
      >
        Open your dashboard.<br />
        Ask <HighlightWords text="Roy" words={["Roy"]} bold={false} /> your first question.
      </div>

      <div
        style={{
          backgroundColor: palette.highlight,
          borderRadius: 18,
          padding: "22px 44px",
          opacity: Math.min(btnP, 1),
          transform: `scale(${interpolate(Math.min(btnP, 1), [0, 1], [0.9, 1])})`,
          boxShadow: btnGlow,
        }}
      >
        <span
          style={{
            fontFamily,
            fontSize: 36,
            fontWeight: 700,
            color: palette.bg,
            letterSpacing: "-0.01em",
          }}
        >
          Try Ask Roy
        </span>
      </div>

      <div
        style={{
          fontFamily,
          fontSize: 28,
          fontWeight: 500,
          color: palette.textSec,
          opacity: urlP,
        }}
      >
        royalti.io
      </div>
    </AbsoluteFill>
  );
};

// ── Inner composition (uses palette + beats from context) ─────────────────

const AskRoyInner: React.FC<{ narrationFile: string; screenshotFile: string }> = ({
  narrationFile,
  screenshotFile,
}) => {
  const palette = usePalette();
  const storyboard = useStoryboard();
  // Resolve every beat's frame range from the storyboard context, so any
  // future tweak to askRoyBeats automatically propagates here.
  const [hook, problem, reveal, demo, shot, cta] = storyboard.beats;

  return (
    <AbsoluteFill style={{ backgroundColor: palette.bg }}>
      <Audio src={staticFile(narrationFile)} />

      <Sequence
        from={hook.frames!.start}
        durationInFrames={hook.frames!.end - hook.frames!.start + XFADE_FRAMES}
      >
        <HookScene />
      </Sequence>
      <Sequence
        from={problem.frames!.start}
        durationInFrames={problem.frames!.end - problem.frames!.start + XFADE_FRAMES}
      >
        <ProblemScene />
      </Sequence>
      <Sequence
        from={reveal.frames!.start}
        durationInFrames={reveal.frames!.end - reveal.frames!.start + XFADE_FRAMES}
      >
        <RevealScene />
      </Sequence>
      <Sequence
        from={demo.frames!.start}
        durationInFrames={demo.frames!.end - demo.frames!.start + XFADE_FRAMES}
      >
        <DemoScene />
      </Sequence>
      <Sequence
        from={shot.frames!.start}
        durationInFrames={shot.frames!.end - shot.frames!.start + XFADE_FRAMES}
      >
        <ScreenshotScene screenshotFile={screenshotFile} />
      </Sequence>
      <Sequence
        from={cta.frames!.start}
        durationInFrames={cta.frames!.end - cta.frames!.start}
      >
        <CtaScene />
      </Sequence>

      {/*
        CaptionBar reads useCurrentFrame() at the ABSOLUTE composition frame —
        must be a sibling of Sequences, never inside one.
      */}
      <CaptionBar phrases={CAPTIONS} />
    </AbsoluteFill>
  );
};

// ── Composition root (wires BrandProvider + StoryboardProvider) ───────────

export const AskRoyClipVideo: React.FC<AskRoyClipVideoProps> = ({
  narrationFile,
  screenshotFile,
  renderRung,
}) => {
  const isLofi = renderRung === "1_lofi";
  return (
    <BrandProvider palette={askRoyPalette} lofi={isLofi}>
      <StoryboardProvider
        slug="ask-roy"
        beats={askRoyBeats}
        narration={askRoyNarration}
      >
        <AskRoyInner
          narrationFile={narrationFile}
          screenshotFile={screenshotFile}
        />
      </StoryboardProvider>
    </BrandProvider>
  );
};

// ── Self-registration ─────────────────────────────────────────────────────

defineComposition({
  id: "AskRoyClip",
  component: AskRoyClipVideo,
  fps: 30,
  width: 1080,
  height: 1920,
  durationInFrames: TOTAL_FRAMES,
  defaultProps: {
    narrationFile: "ask-roy/narration.mp3",
    screenshotFile: "ask-roy/audit-story.png",
    renderRung: "2_hifi",
  },
  beats: askRoyBeats,
  narrationFile: "ask-roy/narration.mp3",
  schema: askRoyClipVideoSchema,
});

// ── Legacy compat ─────────────────────────────────────────────────────────

/** Retained so any external script that still imports it keeps compiling. */
export async function calculateAskRoyClipMetadata() {
  return {
    durationInFrames: TOTAL_FRAMES,
    fps: 30,
    width: 1080,
    height: 1920,
  };
}
