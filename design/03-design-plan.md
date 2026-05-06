# Design Plan — Ikenga Desktop System

Status: **draft, awaiting review.** No huashu work starts until this is approved.

## Goal

Build a coherent design system for the PA desktop cockpit — tokens, primitives, and patterns that make the app feel like a single deliberate product, not "shadcn defaults wired together."

## Constraints

- **Desktop cockpit, not marketing.** Information density matters more than splash.
- **Tailwind 4 + shadcn/Radix already in place.** We extend, we don't replace.
- **Dark-first** but light mode must be a real second-class citizen, not an afterthought.
- **Multi-mode shell.** App / Mail / Studio / Agents / Files / Sessions / Settings each need to feel distinct without diverging into separate apps.
- **In-flight nav restructure (Phase 6/7).** Don't redesign legacy routes; design against the canonical `mail/`, `outbox/`, agents-rail nav.
- **Huashu license is personal-use.** Output is for prototyping/exploration only — production code lives in `src/`. Anything migrated to the shipping app must be re-built without huashu assets.

## Open questions (please answer before we start)

1. **Brand direction.** Should the PA app inherit Royalti.io marketing brand (Plus Jakarta Sans, current palette) or have its own cockpit identity (closer to Linear / Raycast / Arc)?
2. **Mode visual differentiation.** OK with subtle per-mode tint (background/accent shift) or keep all modes visually identical and rely on the activity bar?
3. **Density default.** Compact (lots on screen, smaller type) or comfortable (more whitespace, larger hit targets)?
4. **Inspiration anchors.** Any apps you want this to feel like? (Linear, Superhuman, Notion, Things, Arc, Raycast, Cron…)
5. **Scope of this pass.** Tokens + primitives + 3–5 hero screens, or full coverage of every route?
6. **Light mode priority.** Audit & polish now, or defer and ship dark-only first?

## Proposed workflow (huashu-design, multi-rung)

Each rung produces HTML concepts in `design/concepts/` so you can review before we commit to anything. We pause for sign-off between rungs.

### Rung 0 — Direction (mood frames, no UI)
Output: `design/concepts/00-mood/` — 3 distinct directions as huashu HTML pages.
- Direction A: "Cockpit" (Linear/Raycast feel — dense, monochrome + one accent, sharp)
- Direction B: "Workshop" (Notion/Cron feel — softer, warmer, slightly more spacious)
- Direction C: "Atelier" (editorial — serif accents, paper-like surfaces, distinctive)
Each direction shows: color palette, type specimen, 1 sample screen tile.
**Checkpoint:** pick one direction (or hybrid).

### Rung 1 — Tokens (no components yet)
Output: `design/concepts/01-tokens/` — token swatches + type scale + spacing/elevation/motion specs in HTML.
- Full palette (brand, neutral, semantic, mode tints) light + dark
- Typography scale with the chosen typeface(s)
- Spacing, radius, elevation, motion tokens
**Checkpoint:** approve token set → write to `design/system/tokens.md`.

### Rung 2 — Primitives (build on tokens)
Output: `design/concepts/02-primitives/` — every shadcn primitive restyled with new tokens, on one page.
- Buttons (variants, sizes, states), inputs, selects, dialogs, sheets, tabs, badges, cards, tables, command palette, tooltips
- Both density modes shown side-by-side
**Checkpoint:** approve primitives → write to `design/system/primitives.md`.

### Rung 3 — Patterns & screens (real layouts)
Output: `design/concepts/03-screens/` — high-fidelity HTML mockups of:
1. **Shell** — activity bar + sidebar + content + side pane (Mail mode shown)
2. **Inbox / triage** (the most-used screen)
3. **Outbox approvals** (email draft review)
4. **Finance dashboard** (data-dense table screen)
5. **Sessions** (Claude session list + editor)
6. **Studio storyboard** (creative workspace, very different shape)
**Checkpoint:** approve screens → these become reference for code migration.

### Rung 4 — System doc
Output: `design/system/` — final markdown specs for tokens, primitives, patterns, mode tinting rules, motion, accessibility notes. This is what engineering implements against.

## Migration path (after design is approved)

Not part of this design phase — listed so we agree on the boundary:
1. Update `src/styles.css` with the new token set
2. Restyle `src/components/ui/*` primitives one at a time (PR per primitive)
3. Audit each route against the patterns doc
4. Drop legacy redirect routes (Phase 6 cleanup) using the new visual baseline

## Deliverables checklist

- [ ] Direction chosen (Rung 0)
- [ ] Token swatches approved (Rung 1)
- [ ] `design/system/tokens.md` written
- [ ] Primitive restyles approved (Rung 2)
- [ ] `design/system/primitives.md` written
- [ ] 6 hero screens approved (Rung 3)
- [ ] Final system doc in `design/system/` (Rung 4)
