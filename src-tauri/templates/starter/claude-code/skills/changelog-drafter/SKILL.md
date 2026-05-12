---
name: changelog-drafter
description: Drafts a short changelog or newsletter entry from a list of shipped items. Use for weekly recaps, "what's new" posts, and product update emails.
---

# Changelog Drafter

Turns a raw list of shipped things into a tight, readable update.

## Output format

```markdown
## {YYYY-MM-DD} — {Headline}

{One-sentence framing of the week / period.}

- **{Thing 1}** — {one sentence on why it matters}
- **{Thing 2}** — {one sentence on why it matters}
- **{Thing 3}** — {one sentence on why it matters}

{Optional: one-line "coming next" teaser.}
```

## Rules

1. Lead each bullet with the user-facing change, not the implementation
   detail. ("Faster export" beats "switched ffmpeg pipeline".)
2. Maximum 6 bullets. If you have more, group them.
3. No marketing adjectives ("amazing", "incredible", "huge").
4. The headline summarizes the theme, not every item. If there's no
   theme, use the date.

## Workflow

1. Take the raw list (commits, ticket titles, freeform notes).
2. Group by user-facing area.
3. Rewrite each as `**{noun phrase}** — {one sentence}`.
4. Draft the framing line last so it reflects the actual bullets.
