# Freeform Video Storyboard System

Reference for the three-rung workflow that replaces the YAML pipeline.

---

## The Three Rungs

| Rung | Key | Purpose |
|------|-----|---------|
| 0 | `0_beat_sheet` | Text-only — timing, labels, intent. No visual output. |
| 1 | `1_lofi` | Wireframe still. `BrandProvider lofi={true}` forces grayscale palette + no glows. Used for fast beat-level composition review. |
| 2 | `2_hifi` | Production render. Full palette, glows, gradients, audio. |

The pipeline advances `current_rung` in `storyboard.json` when every beat at the current rung is `approved`.

---

## BrandProvider + Lo-fi Rendering

Every composition root wraps with `<BrandProvider>`. Passing `lofi={true}` (or a palette with `lofi: true`) automatically substitutes the wireframe palette:

```
bg=#fafafa  surface=#eeeeee  border=#cccccc
accent=#888  highlight=#555  textPri=#222  textSec=#666
```

**Primitive rule:** check `palette.lofi` before applying any glow, gradient, or shadow:

```tsx
const palette = usePalette();
const glow = palette.lofi ? "none" : `0 0 40px ${palette.accent}66`;
// use `glow` in boxShadow
```

This keeps lo-fi stills layout-accurate (same text wrapping as hi-fi) while rendering 10× faster.

---

## Minimal Composition Pattern

```tsx
import { defineBeats } from "@/lib/define-beats";
import { defineComposition } from "@/lib/define-composition";
import { BrandProvider, usePalette } from "@/remotion-ui/themes/BrandProvider";
import { StoryboardProvider, useStoryboard } from "@/remotion-ui/themes/StoryboardProvider";
import { defaultPalette } from "@/remotion-ui/themes/brand";

// 1. Define beats once at module scope
const beats = defineBeats([
  { id: "hook",    label: "Hook",    time: { start: 0,   end: 3.8  } },
  { id: "problem", label: "Problem", time: { start: 3.8, end: 15.3 } },
  { id: "cta",     label: "CTA",     time: { start: 15.3, end: 20.0 } },
], { fps: 30 });

// 2. Inner component reads palette + storyboard
const MyInner: React.FC = () => {
  const palette = usePalette();
  return (
    <AbsoluteFill style={{ backgroundColor: palette.bg }}>
      {/* your scenes */}
    </AbsoluteFill>
  );
};

// 3. Composition root wires providers
export const MyVideo: React.FC = () => (
  <BrandProvider palette={defaultPalette}>
    <StoryboardProvider slug="my-video" beats={beats}>
      <MyInner />
    </StoryboardProvider>
  </BrandProvider>
);

// 4. Self-register — Root.tsx never needs to be touched
defineComposition({
  id: "MyVideo",
  component: MyVideo,
  fps: 30, width: 1080, height: 1920,
  durationInFrames: 600,
  defaultProps: {},
  beats,
});
```

---

## Approval Flow

Each beat has per-rung status: `pending → pending-review → approved | needs-rework`.

```
pending          (initial state, nothing generated yet)
  ↓ agent generates still
pending-review   (waiting for human sign-off in storyboard app)
  ↓ human clicks Approve
approved         (pipeline may advance to next rung)
  ↓ human clicks Needs Rework
needs-rework     (agent revises, re-queues to pending-review)
```

The `/video-bespoke continue` command reads `storyboard.json`, checks `current_rung`, and only advances beats whose status at that rung is `approved`. Beats with `needs-rework` status block advancement until fixed.

---

## useNarrationSync

For word-level timing without the overhead of full TikTok caption pages:

```tsx
import { useNarrationSync } from "@/lib/use-narration-sync";

// Somewhere in the composition root or a beat component:
const sync = useNarrationSync({ words: narration.words, fps: 30 });

// Reveal a UI element exactly when "Roy" is first spoken:
const royFrame = sync.frameForWord("Roy");        // first occurrence
const royFrame2 = sync.frameForWord("Roy", 2);   // second occurrence

// Explicit timestamp → frame (e.g. for scene boundaries):
const sceneStartFrame = sync.frameForSecond(15.256);
```

Returns `null` (not a throwing error) when the word is not found, so you can safely use `royFrame ?? 0` as a fallback.

---

## storyboard.json Location

```
royalti-video-engine/
  input/
    freeform/
      {slug}/
        storyboard.json    ← written by Phase 3 pipeline, read by storyboard app
        narration.mp3
        narration-words.json
```

The storyboard app (Phase 2D) reads `storyboard.json` and writes back status/comment changes. The render pipeline (Phase 3) reads it to decide which beats to render at which rung.
