# Ikenga · Token Spec

Locked 2026-05-03. Source of truth for engineering. Source preview: [`/design/concepts/01-tokens/index.html`](../concepts/01-tokens/index.html).

## Naming axes

```
[data-theme="A|B|C"][data-mode="dark|light"][data-density="compact|comfortable|spacious"][data-workspace="app|mail|outbox|studio|agents|files|sessions|settings"]
```

Set on `<html>`. All four axes are independent and orthogonal.

- **Theme** — color family. A = Dusk Wood (canonical default). B = Kola Daylight. C = Bronze Shrine.
- **Mode** — light / dark. Independent of theme.
- **Density** — compact / comfortable (default) / spacious. Affects only row heights, body size, gap; never accent or surface tokens.
- **Workspace** — which mode the user is in (App / Mail / Studio / Agents / Files / Sessions / Settings / Outbox). Drives constant tints (see §3) — does **not** alter base theme.

Persistence: `localStorage`, key prefix `ikenga-`. Default install ships **A · dark · comfortable · app**.

---

## 1. Structural tokens (theme-agnostic)

These never change between themes or modes. Set on `:root`.

### 1.1 Fonts
```css
--font-display: 'Fraunces', ui-serif, Georgia, serif;
--font-body:    'Inter', system-ui, sans-serif;
--font-mono:    'JetBrains Mono', ui-monospace, Menlo, monospace;
```

### 1.2 Type scale (size / line-height pairs)
| Token | Size | Line | Family · Weight · Tracking | Use |
|---|---|---|---|---|
| `--text-display-xl` | 72px | 1 | Fraunces 500 · -2.2% | hero, landing-page only |
| `--text-display`    | 56px | 1.05 | Fraunces 500 · -2% | dashboard hero |
| `--text-h1`         | 32px | 1.15 | Fraunces 400 · -1.2% | page title |
| `--text-h2`         | 24px | 1.2  | Fraunces 400 · -0.5% | section title |
| `--text-h3`         | 18px | 1.35 | Inter 600 · -0.3% | card title, subnav |
| `--text-body-lg`    | 16px | 1.6  | Inter 400 | comfortable density body |
| `--text-body`       | 14px | 1.55 | Inter 400 | default body, UI |
| `--text-body-sm`    | 13px | 1.5  | Inter 400 | compact density body, dense rows |
| `--text-caption`    | 12px | 1.45 | Inter 400 | meta, helper |
| `--text-micro`      | 11px | 1.4  | Mono 500 · +10% upper | timestamps, eyebrows |
| `--text-code`       | 13px | 1.55 | Mono 500 | code blocks, tokens |

### 1.3 Spacing (4px base)
`--space-0` 0 · `--space-1` 4 · `--space-2` 8 · `--space-3` 12 · `--space-4` 16 · `--space-5` 20 · `--space-6` 24 · `--space-8` 32 · `--space-10` 40 · `--space-12` 48 · `--space-16` 64 · `--space-20` 80

Rule: every padding/margin/gap is one of these. If between two steps, pick the smaller.

### 1.4 Radius
| Token | Value | Use |
|---|---|---|
| `--radius-xs` | 3px | tags, ticks, micro |
| `--radius-sm` | 5px | inputs, chips |
| `--radius-md` | 8px | buttons, cards (workhorse) |
| `--radius-lg` | 12px | panels, tile chrome |
| `--radius-xl` | 16px | modals |
| `--radius-pill` | 999px | avatars, dots, pill buttons |

Don't mix radii within a single component.

### 1.5 Motion
**Durations**
- `--motion-fast: 120ms` — state-only (hover, focus)
- `--motion-base: 180ms` — component-level (tab switch, list reorder)
- `--motion-slow: 260ms` — sheet open, popover
- `--motion-slower: 360ms` — mode swap, theme switch

**Easings**
- `--ease-calm: cubic-bezier(0.2, 0.6, 0.2, 1)` — default. Gentle in, soft out.
- `--ease-decisive: cubic-bezier(0.4, 0, 0.2, 1)` — committed actions (send, confirm).
- `--ease-soft-bounce: cubic-bezier(0.34, 1.32, 0.64, 1)` — celebration only. Never for navigation.

### 1.6 Density (set by `data-density`)

| Density | `--row-h` | `--row-pad-y` | `--body-size` | `--body-lead` | `--gap` |
|---|---|---|---|---|---|
| `compact` | 28px | 5px | 13px | 1.4 | 4px |
| `comfortable` (default) | 36px | 8px | 14px | 1.55 | 8px |
| `spacious` | 44px | 11px | 16px | 1.6 | 12px |

**Component-height tokens** also scale with density. Components consume these (don't hardcode heights):

| Density | `--tab-h` | `--btn-h` | `--btn-h-sm` | `--btn-h-lg` | `--input-h` |
|---|---|---|---|---|---|
| `compact` | 32px | 28px | 22px | 34px | 28px |
| `comfortable` (default) | 38px | 32px | 26px | 40px | 32px |
| `spacious` | 44px | 36px | 30px | 44px | 36px |

`--tab-h` covers `.content-tabs / .content-tab / .dock-head / .dock-tab`. `--btn-h*` cover `.btn / .btn-sm / .btn-lg`. `--input-h` covers `.input`.

Density does **not** alter the type scale or spacing scale, accent or surface tokens — only the variables above and any component-level row/tab heights derived from them. The body baseline (`body { font-size: var(--body-size) }`) means *all* body type tightens or relaxes with density automatically.

---

## 2. Surface palettes (theme × mode = 6 surfaces)

10 tokens per surface. Roles never change; values rewire.

| Token | Role |
|---|---|
| `--bg-base` | Activity bar, deep app frame |
| `--bg-surface` | Sidebar, panes, default cards |
| `--bg-raised` | Hover, active row, popover |
| `--bg-sunken` | Code blocks, headers, terminal |
| `--fg` | Primary text |
| `--fg-muted` | Secondary, captions |
| `--fg-faint` | Timestamps, dividers, micro |
| `--border` | Default border |
| `--border-soft` | Row dividers, inner edges |

### 2.1 Theme A · Dusk Wood (canonical)

**Dark (default)**
```css
--bg-base:     hsl(28, 18%, 4%);
--bg-surface:  hsl(28, 14%, 7%);
--bg-raised:   hsl(28, 11%, 11%);
--bg-sunken:   hsl(28, 22%, 2.5%);
--fg:          hsl(36, 28%, 90%);
--fg-muted:    hsl(32, 11%, 56%);
--fg-faint:    hsl(28,  9%, 36%);
--border:      hsl(28, 14%, 15%);
--border-soft: hsl(28, 14%, 11%);
```

**Light**
```css
--bg-base:     hsl(36, 22%, 96%);
--bg-surface:  hsl(36, 18%, 93%);
--bg-raised:   hsl(36, 14%, 89%);
--bg-sunken:   hsl(36, 26%, 98%);
--fg:          hsl(28, 30%, 14%);
--fg-muted:    hsl(28, 14%, 38%);
--fg-faint:    hsl(28, 12%, 56%);
--border:      hsl(32, 16%, 78%);
--border-soft: hsl(32, 16%, 84%);
```

### 2.2 Theme B · Kola Daylight

**Light (canonical for B)**
```css
--bg-base:     hsl(36, 28%, 96%);
--bg-surface:  hsl(36, 22%, 94%);
--bg-raised:   hsl(36, 18%, 90%);
--bg-sunken:   hsl(36, 32%, 98%);
--fg:          hsl(28, 30%, 12%);
--fg-muted:    hsl(28, 14%, 38%);
--fg-faint:    hsl(28, 12%, 56%);
--border:      hsl(32, 18%, 80%);
--border-soft: hsl(32, 18%, 86%);
```

**Dark**
```css
--bg-base:     hsl(36, 12%, 8%);
--bg-surface:  hsl(36, 10%, 12%);
--bg-raised:   hsl(36, 8%, 16%);
--bg-sunken:   hsl(36, 16%, 6%);
--fg:          hsl(40, 28%, 92%);
--fg-muted:    hsl(36, 10%, 62%);
--fg-faint:    hsl(36, 8%, 42%);
--border:      hsl(36, 12%, 22%);
--border-soft: hsl(36, 12%, 18%);
```

### 2.3 Theme C · Bronze Shrine

**Dark (canonical for C)**
```css
--bg-base:     hsl(180, 14%, 7%);
--bg-surface:  hsl(180, 12%, 11%);
--bg-raised:   hsl(180, 10%, 15%);
--bg-sunken:   hsl(180, 18%, 5%);
--fg:          hsl(40, 18%, 90%);
--fg-muted:    hsl(180, 8%, 60%);
--fg-faint:    hsl(180, 8%, 42%);
--border:      hsl(180, 12%, 22%);
--border-soft: hsl(180, 12%, 18%);
```

**Light**
```css
--bg-base:     hsl(180, 10%, 95%);
--bg-surface:  hsl(180, 8%, 92%);
--bg-raised:   hsl(180, 6%, 88%);
--bg-sunken:   hsl(180, 12%, 97%);
--fg:          hsl(200, 22%, 14%);
--fg-muted:    hsl(200, 10%, 38%);
--fg-faint:    hsl(200, 8%, 58%);
--border:      hsl(180, 12%, 80%);
--border-soft: hsl(180, 12%, 86%);
```

---

## 3. Semantic accents (theme-specific)

Four roles — values rewire per theme. Each role also has a `-soft` variant (used as backgrounds for badges/buttons).

| Role | Meaning | Use |
|---|---|---|
| `--primary` | "The right hand" — decisive action | reply CTA, active nav, unread tick |
| `--achievement` | Trophy, done, won | success toast, deal-won badge, hot-thread count |
| `--danger` | Overdue, destructive | past-due, failed deploys, destructive confirms |
| `--systemic` | Calm observability | agents, system tags, infrastructure |

### Theme A
| | dark | light |
|---|---|---|
| `--primary` (iroko) | `hsl(20, 50%, 34%)` | `hsl(20, 50%, 34%)` |
| `--primary-fg` | `hsl(36, 30%, 92%)` | `hsl(36, 26%, 98%)` |
| `--primary-soft` | `hsl(20, 40%, 14%)` | `hsl(20, 50%, 90%)` |
| `--achievement` (kola) | `hsl(42, 78%, 54%)` | `hsl(42, 78%, 42%)` |
| `--achievement-soft` | `hsl(42, 48%, 18%)` | `hsl(42, 60%, 90%)` |
| `--danger` (oxblood) | `hsl(8, 68%, 46%)` | `hsl(8, 68%, 42%)` |
| `--danger-soft` | `hsl(8, 50%, 16%)` | `hsl(8, 60%, 92%)` |
| `--systemic` (verdigris) | `hsl(170, 28%, 34%)` | `hsl(170, 36%, 32%)` |
| `--systemic-soft` | `hsl(170, 22%, 16%)` | `hsl(170, 30%, 90%)` |

> **Theme A semantic note (dark mode update).** `--primary` is no longer ember — it's **iroko**, the dark hardwood ikenga figurines are carved from. `hsl(20, 50%, 34%)` reads as oiled wood under lamplight, deliberately distinct from any orange-CTA ecosystem (Anthropic, Stripe, etc.). Button text on primary flips to `--fg` (cream) instead of near-black, since iroko is too dark for inverted text.

### Theme B (kola amber as primary, ember as secondary)
| | dark | light |
|---|---|---|
| `--primary` (kola) | `hsl(42, 84%, 60%)` | `hsl(42, 82%, 46%)` |
| `--primary-fg` | `hsl(36, 30%, 8%)` | `hsl(28, 30%, 8%)` |
| `--achievement` (ember) | `hsl(14, 76%, 56%)` | `hsl(14, 72%, 46%)` |
| `--danger` (oxblood) | `hsl(8, 70%, 52%)` | `hsl(8, 68%, 42%)` |
| `--systemic` (verdigris) | `hsl(170, 32%, 46%)` | `hsl(170, 36%, 32%)` |

### Theme C (verdigris primary; oxblood = action-only)
| | dark | light |
|---|---|---|
| `--primary` (verdigris) | `hsl(170, 35%, 50%)` | `hsl(170, 42%, 34%)` |
| `--primary-fg` | `hsl(180, 18%, 6%)` | `hsl(180, 12%, 97%)` |
| `--achievement` (gold) | `hsl(40, 58%, 64%)` | `hsl(40, 64%, 38%)` |
| `--danger` (oxblood / action) | `hsl(8, 70%, 50%)` | `hsl(8, 70%, 42%)` |
| `--systemic` (slate) | `hsl(220, 22%, 56%)` | `hsl(220, 24%, 40%)` |

> **Theme C semantic note.** In C, `--primary` is identity-forward (verdigris carries the "lived-in shrine" feel) and `--danger` (oxblood) takes the decisive-action role. Reply CTAs in Theme C therefore render in oxblood by design.

Full `-soft` variants for B and C: see `01-tokens/index.html` (the canonical source).

---

## 4. Workspace tints (constant across themes)

Tied to **mode only**, not theme. Eight workspaces × 2 modes = 16 values. Each provides a `-bg` (subtle wash) and `-fg` (legible accent).

```css
[data-mode="dark"] {
  --tint-app-bg:      hsl(36, 14%, 11%);   --tint-app-fg:      hsl(36, 28%, 78%);
  --tint-mail-bg:     hsl(42, 30%, 11%);   --tint-mail-fg:     hsl(42, 70%, 62%);
  --tint-outbox-bg:   hsl(14, 38%, 11%);   --tint-outbox-fg:   hsl(14, 72%, 60%);
  --tint-studio-bg:   hsl(8, 40%, 10%);    --tint-studio-fg:   hsl(8, 72%, 60%);
  --tint-agents-bg:   hsl(170, 26%, 10%);  --tint-agents-fg:   hsl(170, 40%, 58%);
  --tint-files-bg:    hsl(28, 14%, 11%);   --tint-files-fg:    hsl(28, 30%, 60%);
  --tint-sessions-bg: hsl(28, 28%, 11%);   --tint-sessions-fg: hsl(28, 60%, 62%);
  --tint-settings-bg: hsl(220, 14%, 11%);  --tint-settings-fg: hsl(220, 26%, 66%);
}
[data-mode="light"] {
  --tint-app-bg:      hsl(36, 22%, 92%);   --tint-app-fg:      hsl(28, 30%, 22%);
  --tint-mail-bg:     hsl(42, 60%, 92%);   --tint-mail-fg:     hsl(42, 80%, 28%);
  --tint-outbox-bg:   hsl(14, 60%, 93%);   --tint-outbox-fg:   hsl(14, 70%, 32%);
  --tint-studio-bg:   hsl(8, 60%, 93%);    --tint-studio-fg:   hsl(8, 70%, 32%);
  --tint-agents-bg:   hsl(170, 36%, 92%);  --tint-agents-fg:   hsl(170, 50%, 24%);
  --tint-files-bg:    hsl(36, 26%, 92%);   --tint-files-fg:    hsl(28, 30%, 22%);
  --tint-sessions-bg: hsl(28, 50%, 92%);   --tint-sessions-fg: hsl(14, 60%, 30%);
  --tint-settings-bg: hsl(220, 22%, 93%);  --tint-settings-fg: hsl(220, 30%, 24%);
}
```

**Tint strength** is a user setting (`data-tint-strength`):
- `off` — workspace tint variables are ignored; pure surface
- `subtle` (default) — used in sidebar gradients, active-state backgrounds
- `strong` — extends to header underlines, brand-mark tinting

---

## 5. Elevation

Light and dark have separate values. Never reuse.

### Dark (Theme A · canonical)
```css
--shadow-1: 0 1px 2px rgba(0,0,0,0.55), 0 0 0 1px rgba(0,0,0,0.25);
--shadow-2: 0 4px 12px -2px rgba(0,0,0,0.55);
--shadow-3: 0 12px 28px -8px rgba(0,0,0,0.6);
--shadow-4: 0 24px 48px -16px rgba(0,0,0,0.65);
```

### Light (Theme A · canonical)
```css
--shadow-1: 0 1px 2px rgba(28, 18, 8, 0.08);
--shadow-2: 0 4px 12px -2px rgba(28, 18, 8, 0.10);
--shadow-3: 0 12px 28px -8px rgba(28, 18, 8, 0.14);
--shadow-4: 0 24px 48px -16px rgba(28, 18, 8, 0.18);
```

Theme C uses cooler shadow tints (`rgba(20, 28, 32, ...)` for light, slightly deeper opacity for dark). Theme B reuses A's values.

| Token | Use |
|---|---|
| (none) | Static surface — the default. |
| `--shadow-1` | Hairline shadow. Rests on, doesn't float. |
| `--shadow-2` | Hover lift, dropdown, tooltip. |
| `--shadow-3` | Popover, sheet, command palette. |
| `--shadow-4` | Modal, dragged item. Sparingly. |

---

## 6. Implementation notes for engineering

1. **Migration path** — replace `src/styles.css` `@theme` block with the contents of `01-tokens/index.html`'s `:root` and theme/mode selectors. Existing 13 tokens map cleanly:
   - `--color-background` → `--bg-base`
   - `--color-card` / `--color-popover` → `--bg-surface` / `--bg-raised`
   - `--color-foreground` → `--fg`
   - `--color-muted-foreground` → `--fg-muted`
   - `--color-border` → `--border`
   - `--color-primary` → `--primary`
   - `--color-destructive` → `--danger`
   - other shadcn variables (`--color-secondary`, `--color-accent`) collapse into the new `--bg-raised` / `--achievement` roles.

2. **next-themes** stays as the mode controller. Add a sibling `data-theme` setter in the same context (small store).

3. **Tailwind 4 `@theme`** consumes top-level vars — keep theme-specific overrides in separate `[data-theme=...][data-mode=...]` blocks below the `@theme` block, since `@theme` won't re-evaluate on attribute change.

4. **Per-component rules of thumb**:
   - One `--primary` per visible region. If two CTAs are competing for the same colour, one is wrong.
   - `--achievement` is a celebration colour. Don't use it for "active state" — that's `--primary`.
   - `--danger` is for genuine warnings. Tags marked "danger" should be acted-on, not routinely visible.
   - `--systemic` is the colour of things running on their own. Use for agent/system messages, never for user actions.
   - Never invent new hues. If you want a colour and the system doesn't have it, the system is wrong — file an issue, don't workaround.

5. **Accessibility** — all text/background pairs in this spec target **AA contrast minimum** (4.5:1 for body, 3:1 for large/UI). Theme A dark and B light have been audited. Theme A light, B dark, C dark, C light to be re-audited during Rung 2 primitive work.
