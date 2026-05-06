# Motion Vocabulary

Named entrance presets and timing helpers for Royalti Video Engine compositions.
Import from `@/motion` — never write raw spring configs in composition files.

---

## Entrance Presets

| Preset | Spring | Best for |
|--------|--------|----------|
| `settle` | heavy (d:18, s:90, m:1.0) | Body content, list items, cards, paragraphs — anything that should land with weight |
| `snap` | light (d:12, s:130, m:0.6) | Headlines, callouts, single-word emphasis, labels — crisp and decisive |
| `bloom` | bouncy (d:9, s:150, m:0.5) | Avatars, stat numerals, badge reveals, burst animations — playful overshoot |

All return a 0→1 progress value. Use for `opacity`, `scale`, `translateY`, etc.

```ts
import { settle, snap, bloom, interpolate } from "@/motion";

// Settle: fade + slide up (body text)
const p = settle({ frame, fps, startAt: cueFrame });
style={{ opacity: p, transform: `translateY(${interpolate(p, [0,1], [24,0])}px)` }}

// Snap: scale in (headline)
const p = snap({ frame, fps, startAt: cueFrame });
style={{ opacity: p, transform: `scale(${interpolate(p, [0,1], [0.85,1])})` }}

// Bloom: pop in (avatar / stat)
const p = bloom({ frame, fps, startAt: cueFrame });
style={{ transform: `scale(${p})`, opacity: Math.min(p, 1) }}
```

---

## Timing Offsets

Shift entrance timing relative to a narration cue frame.

| Helper | Effect | Example |
|--------|--------|---------|
| `lag(ms)` | Entrance appears `ms` after cue | `lag(200)` — card appears 200ms after trigger word |
| `lead(ms)` | Entrance appears `ms` before cue | `lead(100)` — diagram pre-loads 100ms before emphasis |
| `applyOffset(frame, offset, fps)` | Apply to a base frame, clamped to ≥0 | `applyOffset(cueFrame, lag(200), fps)` |

```ts
import { settle, lag, applyOffset } from "@/motion";

const cueFrame = sync.frameForWord("Meet") ?? 0;
const startAt  = applyOffset(cueFrame, lag(200), fps); // 200ms after "Meet"
const p        = settle({ frame, fps, startAt });
```

---

## Spring Presets (advanced)

Export `SPRINGS` gives direct access to the underlying configs for advanced `interpolate()` usage.

```ts
import { SPRINGS } from "@/motion";
import { spring } from "remotion";

const p = spring({ frame, fps, config: SPRINGS.medium });
```

---

## `useActiveBeat`

Hook that resolves the current beat from `useCurrentFrame()`.

```ts
import { useActiveBeat } from "@/lib/use-active-beat";

const { beat, frameInBeat, index } = useActiveBeat();
// beat is null when the frame falls outside all defined beat ranges
```

Auto-pulls beats from `StoryboardProvider`. Pass an explicit array to override:

```ts
const { beat, frameInBeat } = useActiveBeat(myBeats);
```

Pure helper for non-hook contexts (tests, stills):

```ts
import { resolveActiveBeat } from "@/lib/use-active-beat";
const result = resolveActiveBeat(frame, beats);
```
