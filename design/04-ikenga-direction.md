# Ikenga Theme — Research & Direction (DISCUSSION)

Status: **draft for discussion.** Nothing built yet. Goal of this doc: agree on what we're translating from Ikenga → UI before any huashu work.

## What Ikenga is

**Ikenga** (literal Igbo: *"strength of majesty"*) is a horned personal shrine of the Igbo people of southeastern Nigeria — a carved wooden figure embodying a man's *right hand*: his capacity to act, to achieve, to push forward against resistance. It is one of the most distinctive objects in Igbo material culture.

### Core symbolism
- **The right hand (*aka ikenga*)** — the seat of personal power, agency, the force that gets things done.
- **Horns** — primary motif on every ikenga; signify power, daring, a willingness to charge. Usually curled (ram), sometimes straight; void at the center, chip-carved.
- **Knife / machete in right hand** — the tool of action.
- **Trophy in left hand** — severed head, money bag, elephant tusk: proof of achievement.
- **Four-legged stool base** — grounded, planted, sovereign over a personal domain.
- **Chip-carved geometry** — cross/diamond patterns on forehead and back; rhythmic, geometric, hand-cut.

### Material qualities
- Soft or hard wood, sizes from a few inches to ~6 ft.
- **Patina built by use** — dark, rich, layered surface from years of ritual: kola nut, alligator pepper, palm wine, sacrificial offerings. The object accumulates time.
- Pocking, pitting, chipping — *evidence of use is part of the beauty*.
- Some painted, most left as raw + patinated wood.

## Why this is a *good* fit for a PA cockpit

The PA app is, literally, a tool for the user's right hand: triage, decide, ship, follow up, achieve. The metaphor isn't decoration — it's structural:

| Ikenga concept | App translation |
|---|---|
| Right hand = agency | The app is the user's instrument of action |
| Horns = forward charge | Strong primary action, opinionated defaults |
| Trophy in left hand | "Done" / completed / achievement state |
| Patina from use | UI surfaces that subtly record activity (recently-used, hot paths) |
| Chip-carved geometry | Small decorative motifs in dividers, badges, empty states |
| Four-legged base | Stable, grounded shell — the activity-bar/sidebar/content/sidepane never collapses incoherently |

This is also genuinely distinctive — there is no "Ikenga-themed productivity app" out there. We can make something that looks like nothing else.

## Visual translation — proposed direction

### Materiality
- **Surfaces feel like wood and clay**, not glass. Warm darks, soft warm lights — never the cold blue-grey of generic dashboards.
- **Patina accents** — subtle warm glow around frequently-used elements (recently-used nav items, hot inboxes), as if the app has been worn smooth where you touch it most.
- **Hand-marked details** — chip-carve geometric motifs as section dividers, focus rings, empty-state illustrations. Sparingly.

### Palette (proposal — to react to)

**Dark mode — "carved ikenga at dusk"**
- `bg-deep` near-black warmed: `hsl(28, 15%, 8%)` (ironwood)
- `bg-surface` `hsl(28, 12%, 12%)` (carved wood)
- `bg-raised` `hsl(28, 10%, 16%)` (lit edge)
- `fg` `hsl(36, 30%, 92%)` (kola-nut cream)
- `fg-muted` `hsl(32, 12%, 62%)` (worn wood)
- `border` `hsl(28, 14%, 22%)` (chip-carve shadow)
- **Primary accent — "the right hand"**: `hsl(14, 78%, 52%)` (ember / fired clay)
- **Achievement / trophy**: `hsl(42, 82%, 56%)` (kola amber)
- **Action / call-to-arms**: `hsl(8, 70%, 48%)` (oxblood — sacrificial patina)
- **Calm / sovereign**: `hsl(170, 30%, 38%)` (verdigris bronze)

**Light mode — "carved ikenga in daylight"**
- `bg-deep` `hsl(36, 28%, 96%)` (raw clay)
- `bg-surface` `hsl(36, 22%, 92%)` (washed bone)
- `bg-raised` `hsl(36, 18%, 88%)` (paper)
- `fg` `hsl(28, 30%, 12%)` (ironwood)
- `border` `hsl(32, 18%, 78%)`
- Same accents (slightly desaturated) so brand reads consistent across modes.

These are starting points — Rung 1 will refine with real swatches.

### Per-mode tinting (each mode = a "trophy" symbol)

The user said "per mode, configurable." Each mode gets a faint warm-shifted tint pulled from the Ikenga symbol set:

| Mode | Symbol | Tint hue | Feel |
|---|---|---|---|
| App (home) | the figure itself | neutral wood | grounded |
| Mail | kola nut | amber `~42°` | hospitable, awaits response |
| Outbox | machete / right hand | ember `~14°` | decisive, outbound |
| Studio | palm wine | oxblood `~8°` | creative, fired |
| Agents | bronze ring | verdigris `~170°` | systemic, watchful |
| Files | wood grain | neutral warm | archival |
| Sessions | shrine flame | amber→ember gradient | active conversation |
| Settings | stool base | cool clay | structural |

Tint affects: sidebar background gradient (very subtle), accent of active-nav indicator, header underline. Body content stays neutral so data reads cleanly. **Tint strength is a setting** (off / subtle / strong).

### Density (configurable)
- **Compact** — Linear-tight: 28px row, 13px body, 1.4 line-height
- **Comfortable** (default) — 36px row, 14px body, 1.5 line-height
- **Spacious** — 44px row, 15px body, 1.6 line-height

### Typography
Two candidate stacks to react to:
- **(A) Pairing — distinctive:** *Fraunces* (display, with optical sizes; carries a carved/sculpted feel) + *Inter* (body) + *JetBrains Mono* (terminal/code). Fraunces only on h1/empty-state/branding moments — body stays neutral.
- **(B) Single — clean:** *Söhne* / *Geist* / *Inter Tight* throughout, no display face. Faster to build, less character.

I'd lean (A) — Fraunces' soft serifs at display sizes echo the carved-wood feel without being kitsch.

### Iconography & motifs
- **Lucide stays** for functional icons (don't reinvent the wheel).
- **Custom set, ~6 motifs**, hand-drawn at the chip-carve geometry: ikenga-horn glyph (used as "achievement" marker), kola-nut, machete, stool, four-line mark (Igbo body-art callback), bronze ring. Used sparingly: app launcher, empty states, achievement toasts.
- **Forbidden**: literal masks, tribal-cliché ornaments, anything that reads as costume rather than structure. The theme should be felt, not announced.

### Cultural-sensitivity guardrails
- Ikenga is a sacred personal object, not a decorative pattern. We honor it by *referencing the principles* (right hand, achievement, patina from use) — not by slapping carved figurines into UI.
- No depictions of the figure itself in chrome or marketing.
- One-line attribution in About / settings: "Inspired by *ikenga*, the Igbo shrine to personal achievement."
- If anyone from the community tells us a specific element is off, we change it.

## Decisions (2026-05-03)

1. **Palette warmth** — **dusk-wood** is the default. Theme A.
2. **Accent boldness** — Q dissolved. The system ships **three themes**, each with its own primary; not one shared accent. Per `_shared/tokens.css`:
   - Theme A (dusk-wood) → `--primary: hsl(20,50%,34%)` (oxblood, default)
   - Theme B (kola-daylight) → `--primary: hsl(42,82%,46%)` (amber)
   - Theme C (bronze-shrine) → `--primary: hsl(170,35%,50%)` (verdigris)
   The earlier list of ember/kola/oxblood/verdigris swatches was confusing because it implied parallel candidates for one slot — they are per-theme primaries.
3. **Display typeface** — **Fraunces** (variable serif, optical sizes). Inter for body, JetBrains Mono for code. Fraunces only at display sizes (h1, empty states, branding moments).
4. **Motif scope** — **commission the 6-motif custom icon set**: ikenga-horn, kola-nut, machete, stool, four-line mark, bronze ring. Tracked in next-steps as a separate workstream.
5. **Cultural attribution** — **both**: one-line attribution in About / Settings, plus a `/design/CULTURAL-NOTES.md` documenting research, sources, and decisions for future maintainers.
6. **Default mode-tint strength** — **subtle** out of the box (off / subtle / strong remain user-configurable).

Mood-frame Rung 0 has shipped (`design/concepts/00-mood/A-dusk-wood.html`, `A-dusk-wood-darker.html`, `B-kola-daylight.html`, `C-bronze-shrine.html`). Next: port the agreed tokens into `src/`.

## Sources used in research
- [Ikenga — Wikipedia](https://en.wikipedia.org/wiki/Ikenga)
- [Ikenga — Smarthistory](https://smarthistory.org/ikenga/)
- [Ikenga Statue (Igbo) — Duke Sacred Arts](https://sacredart.caaar.duke.edu/artifacts/ikenga-statue-igbo/)
- [Figure (Ikenga) — Brooklyn Museum](https://www.brooklynmuseum.org/opencollection/objects/105298)
- [Ikenga — British Museum](https://www.britishmuseum.org/collection/object/E_Af1949-46-192)
- [Ritual Enactment of Achievement: "Ikenga" Symbol — JSTOR](https://www.jstor.org/stable/40341633)
