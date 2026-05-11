---
name: release-planner
description: Produces and updates a single-source-of-truth release plan markdown — covers metadata, assets, splits, distribution, and marketing milestones. Use when starting or updating a release.
---

# Release Planner

Maintains one markdown plan per release with five canonical sections so
the team always knows what's missing.

## When to use

- A new release is being scoped.
- Someone asks "where are we on the release?".
- A milestone (artwork in, masters approved, splits signed) needs to be
  recorded.

## Plan template

```markdown
# Release · {Artist} — {Title}

- Format: {single | EP | album}
- Release date: {YYYY-MM-DD}
- UPC: {…}
- Primary territory: {…}

## Assets

- [ ] Final masters (WAV, 44.1/24)
- [ ] Cover artwork (3000×3000 PNG/JPG)
- [ ] Press shots
- [ ] Lyric sheet
- [ ] Credits sheet

## Metadata

- [ ] ISRCs assigned per track
- [ ] Songwriter splits documented
- [ ] Producer / engineer credits

## Splits & Rights

- [ ] Recording splits signed
- [ ] Publishing splits documented
- [ ] PRO registrations queued

## Distribution

- [ ] DSP delivery scheduled
- [ ] Pre-save link live
- [ ] Sync clearances (if needed)

## Marketing

- [ ] Announcement date
- [ ] Press list
- [ ] Social calendar
- [ ] Newsletter slot
```

## Workflow

1. If no plan exists, create `releases/{YYYY-MM-DD}-{slug}.md` using the
   template.
2. If a plan exists, update only the lines that changed. Don't rewrite
   completed checkboxes.
3. After updating, print a 3-line summary: "what's done", "what's
   blocking", "next milestone".
