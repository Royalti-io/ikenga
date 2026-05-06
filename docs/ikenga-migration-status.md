# Ikenga design-system migration · status

Tracker for which routes use the Ikenga design tokens (`src/lib/ikenga/tokens.css`) directly via per-screen CSS files, vs. raw Tailwind/shadcn (which still resolves to Ikenga tokens through `@theme` aliases in `src/styles.css`, but with off-palette colors like `bg-sky-100`, `text-amber-700`, etc.).

Updated: 2026-05-04 (after Screen 09 outbox-flows port).

## Legend

- **Native** — has its own `*.css` with Ikenga vars + custom class prefix; matches a specific design concept screen
- **Aliased** — uses Tailwind/shadcn classes that route to Ikenga tokens; acceptable for now but visually drifts from spec
- **Off-palette** — uses literal color classes (`bg-sky-100`, `text-amber-700`, `bg-green-600`, etc.) that bypass the design system and need migration

## Outbox (Rung 3 / Screen 09) — done

| Route | Status | Notes |
|---|---|---|
| `outbox/route.tsx` | Native | `outbox.css` `.ob-*`, workspace tint via existing `data-workspace="outbox"` |
| `outbox/email/index.tsx` | Native | Deadline grouping, draft footer with handoff buttons, chip variants |
| `outbox/newsletter/index.tsx` | Native | Filter strip, frame chrome, draft footer w/ handoff |
| `outbox/sequences/index.tsx` | Native | Master/detail with stepper |
| `outbox/social/index.tsx` | Native | Per-platform char-bar, platform pills via chip classes |
| `outbox/sent/index.tsx` | Native | Filter chips, sent-row timeline |

Open follow-up:
- Real **Send-to-chat** wiring — the `HandoffButtons` component currently `console.warn`s for ⌘K. Needs the dock-chat composer to expose a "load with seed" entry point.
- The keyboard map (J/K nav, ⌘S, ⌘↵, ⌘⇧↵, ⌘⌫, ⌘⇧K, ⌘⇧N) is mentioned in tooltips/headers but not actually bound. Wire via `useHotkeys` once row focus management lands.
- Resume-session picker reads from `claudeListSessions` (all projects). Could be tightened to filter by recent draft-id mentions in JSONL — design Section I describes this but it's a lookup-cost question.
- "Apply to draft" affordance on chat replies (Section K) — needs schema for `email_drafts.prior_versions[]` and a chat-message → draft-id linkage. Not built.

## Already-Native screens

| Route | CSS file | Class prefix | Source design |
|---|---|---|---|
| `tasks/route.tsx` + `tasks/index.tsx` | `tasks/tasks.css` | `.tk-*` | Screen 08 |
| `sessions/route.tsx` + descendants | `sessions/sessions.css` | `.sb-*` | Screen 06 |
| `claude/*` | `shell/claude-config/claude-config.css` | (claude-specific) | Screen 07 |

## Off-palette / Aliased — needs migration

These routes still use literal Tailwind colors (e.g. `bg-amber-100`, `text-sky-700`, `bg-green-600`) instead of Ikenga semantic tokens. They render correctly because the @theme aliases cover the structural cases, but visually drift from the locked palette.

| Route | Severity | Why |
|---|---|---|
| `mail/*` | High | Inbox is the most-touched screen; Tailwind colors throughout. Has design Screen 01 for reference. |
| `finance/*` | High | Tabs custom-styled, currency badges use `bg-emerald-50`-style classes. Screen 05 design exists. |
| `triage/*` | Medium | Reuses inbox patterns; should follow inbox migration. |
| `delegations/*` | Medium | Generic shadcn cards; relatively easy lift. |
| `agent-runs/*` | Medium | Status badges use literal colors. |
| `cron/*` | Medium | Status indicators use literal colors. |
| `email-queue/*` | Low | Predates outbox restructure; partially superseded by `/outbox/*`. |
| `social-queue/*` | Low | Predates outbox restructure; partially superseded by `/outbox/social`. |
| `newsletter-queue/*` | Low | Predates outbox restructure; superseded by `/outbox/newsletter`. |
| `fundraising/*` | Low | Mostly tabular data; aliased classes are fine. |
| `partnerships/*` | Low | Same. |
| `sales/*` | Low | Same. |
| `settings/*` | Low | Form-heavy; shadcn primitives already do the work. |
| `storyboard/*` | N/A | Has its own design language (storyboard-specific). |
| `reports/*` | Low | Mostly markdown render. |
| `tasks/$taskId.tsx` | Medium | Detail pane is partly Tailwind colors despite the list being Native. |
| `*-smoke.tsx` | N/A | Throwaway dev pages. |

## Conventions for future ports

When adding a new Native screen:

1. Create `src/routes/<area>/<area>.css`
2. Use a unique class prefix (e.g. `.ob-`, `.tk-`, `.sb-`)
3. Reference only Ikenga variables — never `bg-amber-100`, etc.
4. Leverage the `--tint-fg-active` workspace tint var instead of hardcoded primaries
5. Import the CSS at the top of the area's `route.tsx` so it loads when the route mounts
6. Mirror the design concept HTML — keep classes 1:1 with the spec where reasonable
7. Place support components under `src/routes/<area>/-components/` (note the `-` prefix — TanStack Router treats that as ignored, while `_components` becomes a pathless route)

## Tokens reference

- `src/lib/ikenga/tokens.css` — single source of truth
- Mirrors `design/concepts/_shared/tokens.css` verbatim
- Updated by editing both in sync — `tokens.css` in design first, then mirror

## Color cheat-sheet (use these, not Tailwind literals)

```
fg / fg-muted / fg-faint           # text
bg-base / bg-surface / bg-raised   # surfaces
bg-sunken                          # darker than base, for nested elements
border / border-soft               # hairlines
primary / primary-fg / primary-soft       # default action
achievement / achievement-soft            # success / sent
danger / danger-fg / danger-soft          # destructive / overdue
systemic / systemic-soft                  # neutral system status
tint-fg-active / tint-bg-active           # workspace-tinted (resolves per /outbox, /mail, etc.)
```
