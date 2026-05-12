---
name: track-brief
description: Produces a per-track brief with metadata, credits, and pitch hooks. Use when adding a track to a release plan or preparing pitch sheets for DSPs / press.
---

# Track Brief

One markdown file per track. Keeps metadata, credits, and the "why
people should care" sentence in one place.

## Template

```markdown
# Track · {Title}

- ISRC: {…}
- Length: {m:ss}
- BPM: {…}
- Key: {…}
- Language: {…}
- Explicit: {yes | no}

## Credits

- Writers: {Name — split %}
- Producers: {…}
- Performers: {…}
- Mixed by: {…}
- Mastered by: {…}

## Pitch hook

{One sentence: why this track stands out — sonic reference, lyric
 angle, cultural moment, or feature.}

## Editorial angles

- {Press angle 1}
- {Press angle 2}

## Sync potential

{One sentence on where this could land — TV / film / ads / games — or
 "none" if not pitching for sync.}
```

## Rules

1. ISRC, splits, and credits are not optional — flag missing fields
   explicitly with `[MISSING]`.
2. The pitch hook is one sentence. No paragraphs.
3. Editorial angles must be specific. "Great vocal" is not an angle.
