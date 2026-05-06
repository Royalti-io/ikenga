# Ikenga · Primitives Spec

Locked 2026-05-03. Source preview: [`/design/concepts/02-primitives/index.html`](../concepts/02-primitives/index.html). Tokens this builds on: [`tokens.md`](./tokens.md).

This spec lists every primitive, its variants, states, and the tokens it consumes. Engineering source of truth — implement against this, not the HTML preview.

## Conventions

- All primitives consume tokens from `tokens.md`. Never use raw hex/rgb in component code.
- All sizes derive from `--space-*` and `--text-*`. No magic numbers.
- All transitions use `--motion-fast` (default for state changes) or `--motion-base` (for component-level).
- Default ease is `--ease-calm`. Use `--ease-decisive` only for committed actions, `--ease-soft-bounce` only for celebration toasts.
- Focus rings: `outline: 2px solid var(--primary); outline-offset: 2px;` on all interactive primitives.

---

## 1. Button

**Variants:** `primary` · `secondary` · `outline` · `ghost` · `destructive`
**Sizes:** `sm` (26px) · `md` (32px, default) · `lg` (40px)
**Modifiers:** `icon-only` · `loading` · `disabled`

| Token used | Where |
|---|---|
| `--primary` / `--primary-fg` | primary background + foreground |
| `--bg-surface` → `--bg-raised` | secondary, hover lift |
| `--border` | outline border |
| `--fg-muted` → `--fg` | ghost color shift on hover |
| `--danger` / white | destructive |
| `--radius-md` | corner radius (workhorse) |
| `--text-body-sm` (md), `--text-caption` (sm), `--text-body` (lg) | font size |

**Theme C exception:** `--primary` (verdigris) is identity, not action. Decisive CTAs (Reply / Send / Confirm) use the **destructive** variant in Theme C. Document this in component story.

---

## 2. Button group (segmented)

Container: `border + padding 2px + bg-base`. Items: `btn` with no border, no background. Active item: `bg-raised + shadow-1`.

Used for: time-range pickers (Day/Week/Month), view toggles (grid/list).

---

## 3. Input

**States:** default · hover · focus · error · disabled
**Variants:** `input` · `textarea` (min-height 80px, vertical resize) · `select` (custom chevron)

| Token | Where |
|---|---|
| `--bg-sunken` | default fill (reads as a well, not a tile) |
| `--bg-surface` | focus fill |
| `--border` → `--fg-faint` (hover) → `--primary` (focus) | border progression |
| `--danger` | error border |
| `--fg-faint` | placeholder |
| `--radius-sm` | corner |
| `--text-body-sm` | font size |
| height: 32px | comfortable; 28 compact; 40 spacious |

**Field composition:** `field-label` (12px, 500, fg-muted) + input + `field-help` or `field-error` (11px). Error fills are forbidden — only border + below-the-input message in `--danger`.

---

## 4. Input group

Container border wraps `input + addon(s)`. Addons sit flush, separated by `border-soft` 1px. Used for: search (icon left, ⌘K right), prefixed paths, units.

Focus ring inherits the wrapper, not the inner input.

---

## 5. Switch / Checkbox

**Switch:** 32×18 track, 12×12 thumb, `--radius-pill`. Off: `--bg-raised` track. On: `--primary` track + `--primary-fg` thumb.

**Checkbox:** 16×16, `--radius-xs`. Off: `--bg-sunken + --border`. On: `--primary` fill + checkmark in `--primary-fg`.

Both transition at `--motion-base`.

---

## 6. Badge / Tag

`font-mono`, 10px, +6% letter-spacing, uppercase, `--radius-xs`, 3px×8px padding.

**Variants:** `neutral` (default) · `primary` · `achievement` · `danger` · `systemic` · `solid-primary`

Each semantic variant uses `*-soft` background + border + `--{role}` text color, except `solid-*` which inverts.

**Optional `badge-dot`:** 5px circle in `currentColor`. Used for status indicators inside badges.

**Rule:** badges are metadata. If a badge is the loudest thing on screen, the screen is wrong.

---

## 7. Avatar

**Sizes:** `sm` 22 · `md` 32 (default) · `lg` 44 · `xl` 64
**Style:** circle, `--radius-pill`, gradient fill from `*-soft` to `*` (default uses `--primary-soft` → `--primary`), Fraunces 500 initial.

**Status dot:** 10×10, bottom-right, 2px ring matching parent surface. `--achievement` for online, `--fg-faint` for offline.

**Stack:** overlapping with -8px margin and 2px parent-surface ring. `+N` overflow uses `--bg-raised` fill, mono 10px.

---

## 8. Alert

Grid: `icon · body · action/dismiss`. Border + soft background using `color-mix(in srgb, --{role}-soft 50-60%, --bg-surface)`.

**Variants:** `info` (systemic) · `success` (achievement) · `warn` (primary) · `danger` (danger).

Title (600, body size) + body (muted, 13px). Dismiss button is `btn-ghost btn-sm` with X icon.

---

## 9. Card

`bg-surface + border + radius-md`. Optional `card-header` (border-bottom-soft) + `card-body` + `card-foot` (border-top-soft, `bg-sunken`, right-aligned actions).

`card-title` is Fraunces 500 at h3 size. Subtitle is caption muted.

Cards never get `shadow-*` by default — they're flat. Elevation is reserved for floating things.

---

## 10. Tabs

**Section tabs (default):** flex strip + `border-bottom-soft`. Items 36px tall, body-sm. Active: `--fg` color + `--primary` 2px underline that overlaps the strip border.

**Pill tabs:** `bg-base` container + 2px padding + items at 28px with `--radius-sm`. Active: `--bg-raised + shadow-1`.

**Counts:** mono 10.5px, `--fg-faint` default, `--primary` when tab is active.

Used for: Mail/Outbox subsections (section), in-pane filters (pill).

---

## 11. Accordion

Outer `border-soft + radius-md`. Items separated by `border-soft`. Trigger: full-width button, body weight, chevron in `--fg-faint`. Open: chevron rotates 90deg via `--motion-base`. Content: 13px muted, line-height 1.6.

---

## 12. Tooltip

Bubble: `bg-base + border + radius-sm + shadow-2`. Mono 11px uppercase. 4px arrow via `::after`. Default position: top-center.

Trigger delay: 400ms (use Radix default). Show in micro-second states only — never use to reveal critical info.

---

## 13. Popover / Dropdown

Pane: `bg-surface + border + radius-md + shadow-3`, 2px padding, min-width 240px.

**Items:** body-sm, `radius-sm`, gap-2, hover `bg-raised`. Optional left icon (`fg-faint`) + right shortcut (mono 10.5px). Divider = 1px `border-soft` with my-1.

Destructive items use `--danger` text color.

---

## 14. Hover card

280px wide, `bg-surface + border + radius-md + shadow-3`, padded p-4. Header: avatar + name (600) + handle (mono micro). Body: muted 13px. Meta row: badges + faint mono micro.

Used for: people refs, deal refs, agent refs in inline text.

---

## 15. Sheet (right-edge drawer)

Sheet pane: `bg-surface + border + radius-md + shadow-4`, padded p-5. Sits over scrim (`rgba(0,0,0,0.4)` dark / `rgba(28,18,8,0.18)` light).

Composition:
- **head:** title (Fraunces 500, h3) + meta (mono micro) + close button (ghost icon)
- **body:** the actual content (varies by use)
- **foot:** action buttons, right-aligned, separated by `border-soft` top

Slide-in: `--motion-slow` `--ease-calm`, transform-x.

---

## 16. Dialog (modal)

Centered over scrim. Width: 440 default, 90% max. `bg-surface + border + radius-xl + shadow-4`, padded p-6.

Composition: title (Fraunces 500, h2) + body (muted body) + optional middle content card (`bg-sunken + border-soft`) + foot buttons (right, gap-2).

Reserved for **commitment moments**: send-all, delete, irreversible. Don't use for "are you sure" — that's an alert with an undo, not a modal.

---

## 17. Command palette

Width 540px max, `bg-surface + border + radius-lg + shadow-4`.

**Composition:**
1. Input row: search icon + input (body-lg) + `esc` badge
2. List: scrollable, max-height 340px, p-2
   - `command-group-label` (mono 10px, uppercase, `--fg-faint`)
   - `command-item` (body-sm, gap-2, padded). Active = `bg-raised`. Optional shortcut on right (`<kbd>` styled).
3. Foot: mono 10px hint strip with key bindings, `bg-sunken + border-top-soft`.

`<kbd>` style: `bg-base + border-soft + radius-xs`, 1px×5px padding.

This is the most-used surface in the app — give it the most polish.

---

## 18. Scroll-area

Custom webkit scrollbar: 6px wide, transparent track, `--border` thumb, `--fg-faint` thumb on hover, `radius-sm` thumb radius.

---

## 19. Spinner / Progress

**Spinner:** 18×18, 2px `--bg-raised` ring with `--primary` top, `spin 0.7s linear infinite`. Inline by default.

**Progress bar:** 6px tall, `radius-pill`, `--bg-raised` track, `--primary` (or `--achievement` for "good progress") fill. Width transitions at `--motion-slow`.

---

## 20. Separator

Horizontal: 1px `--border-soft`, full width.
Vertical: 1px wide, 24px tall by default. Used inline between meta items.

---

## Density rules

Density only affects:
- `--row-h` (28 / 36 / 44)
- `--row-pad-y` (5 / 8 / 11)
- `--body-size` (13 / 14 / 16)
- `--gap` (4 / 8 / 12)

Type scale, spacing scale, radius scale, accent tokens, surface tokens — all unchanged.

Density is set globally on `<html>`. Components must read it from there, never hard-code `28/36/44`.

---

## Implementation notes

1. **shadcn migration**: existing `src/components/ui/*` files mostly need only token-name swaps (`hsl(var(--background))` → `var(--bg-base)`, etc.) plus a few semantic fixes (e.g., `Button` destructive uses `--danger` not `--destructive`).
2. **next-themes**: keeps managing the `light` / `dark` class — but we move to `data-mode="dark"` / `data-mode="light"` on `<html>` for consistency with theme/density attrs. Either keep next-themes (and add a sibling `data-theme` setter) or migrate to a thin custom store. Prefer the latter long-term.
3. **Theme C action color override**: in Button component code, when `data-theme="C"` and variant is `primary`, render with `--danger` token. This is the only theme-conditional logic in primitives — keep it documented and isolated.
4. **Command palette**: the kbd styling is the only place the system uses a `<kbd>` element. Keep that consistent everywhere shortcuts appear (including dropdowns and footers).
5. **Forbidden patterns**:
   - No "filled" error states on inputs (border-only).
   - No emoji in any primitive.
   - No purple, blue-grey, or stock-shadcn defaults anywhere.
   - No `font-style: italic` on body text — italics are a Fraunces signature, used at display + h1/h2 only.
