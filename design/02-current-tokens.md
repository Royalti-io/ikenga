# Current Theme Tokens

Snapshot of `src/styles.css` as of 2026-05-03.

## Color tokens

| Token | Light | Dark |
|---|---|---|
| `border` | hsl(220 13% 91%) | hsl(216 34% 17%) |
| `input` | hsl(220 13% 91%) | hsl(216 34% 17%) |
| `ring` | hsl(220 70% 50%) | hsl(216 84% 60%) |
| `background` | hsl(0 0% 100%) | hsl(224 71% 4%) |
| `foreground` | hsl(224 71% 4%) | hsl(210 20% 98%) |
| `primary` | hsl(220 70% 50%) | hsl(216 84% 60%) |
| `primary-foreground` | hsl(210 20% 98%) | hsl(210 20% 98%) |
| `secondary` | hsl(220 14% 96%) | hsl(215 28% 17%) |
| `secondary-foreground` | hsl(220 9% 46%) | hsl(210 20% 98%) |
| `muted` | hsl(220 14% 96%) | hsl(215 28% 17%) |
| `muted-foreground` | hsl(220 9% 46%) | hsl(217 11% 65%) |
| `accent` | hsl(220 14% 96%) | hsl(215 28% 17%) |
| `accent-foreground` | hsl(224 71% 4%) | hsl(210 20% 98%) |
| `destructive` | hsl(0 84% 60%) | hsl(0 63% 31%) |
| `card` / `popover` | hsl(0 0% 100%) | hsl(224 71% 6%) / hsl(224 71% 4%) |

## Other tokens

- `--radius: 0.5rem` (single value)
- Font stack: `ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`
- No spacing scale beyond Tailwind defaults
- No typography scale (sizes, weights, line-heights)
- No elevation/shadow tokens
- No motion tokens (durations/easings)
- No semantic colors (success, warning, info)

## What's missing for a system

1. **Brand palette** — primary blue is generic shadcn; needs Royalti hue + supporting accents
2. **Semantic colors** — success / warning / info; status colors for mail (unread, triaged, snoozed) and finance (income, expense, transfer, settled)
3. **Surface scale** — `surface-0/1/2/3` instead of the single `card`/`popover` pair, useful for the stacked panes
4. **Typography scale** — display, h1–h4, body, small, code (terminal/inline)
5. **Density modes** — compact (mail list, finance) vs comfortable (chat, dashboard)
6. **Elevation** — at least `low/med/high` shadow tokens, with dark-mode equivalents
7. **Motion** — durations (fast/base/slow) + easings; the iyke shimmer hints at a spec
8. **Mode tinting** — subtle mode-aware accent (e.g., Mail = neutral, Studio = warm, Agents = cool) so users feel context
