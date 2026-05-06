# App Inventory — Ikenga Desktop

Captured 2026-05-03. Source of truth = code; this is a flattened summary for design work.

## 1. What the app is

A Tauri 2 desktop app that wraps a React 19 / TanStack Router frontend over Rust-managed PTYs, Claude sessions, and bun-compiled sidecars. Acts as a **personal-assistant cockpit** for the founder: email triage, outbox approvals, sales/partnership pipeline, finance, content, agents observability, and a Studio for video/storyboard work.

Multi-mode shell, not a single-page app. Mode is chosen via the **activity bar** (left edge); each mode swaps the sidebar contents and the content pane.

## 2. Shell anatomy

```
┌─────────┬──────────────┬─────────────────────────┬──────────────┐
│Activity │ Sidebar      │ Content pane            │ Side pane    │
│ bar     │ (mode-       │ (route outlet)          │ (Terminal /  │
│ (icons) │  specific    │                         │  Chat /      │
│         │  nav)        │                         │  Viewer/Off) │
└─────────┴──────────────┴─────────────────────────┴──────────────┘
```

- `src/shell/workspace.tsx` — PanelGroup, panel sizes persisted in SQLite
- `src/shell/activity-bar.tsx` + `src/shell/mini-apps-config.ts` — 7 modes (App, Mail, Studio, Agents, Files, Sessions, Settings)
- `src/shell/sidebar-modes/*` — one file per mode, owns its sidebar UI
- `src/shell/panes/*` — terminal / chat / viewer side-pane tabs
- `src/shell/command-palette.tsx` — ⌘K universal search & deep-link
- `src/shell/native-menu.ts` — macOS menu bar
- `src/shell/section-tabs.tsx` — shared tab strip (Mail/Outbox sub-sections)

## 3. Navigation (App mode) — `src/shell/nav-config.ts`

| Group | Items |
|-------|-------|
| (top) | Dashboard `/`, Sessions `/sessions`, Inbox `/mail/inbox` |
| Daily Ops | Triage, Tasks, Emails (all), Reply Drafts, Calendar |
| Pipeline | Strategy, Sales, Partnerships, Fundraising, Finance |
| Outbox | Email, Newsletter, Social, Sequences, Sent |
| Product | Executive, Features, Content |

Other modes have their own sidebars:
- **Mail** — Inbox / Triage / All / Drafts (mirror of Daily-Ops mail)
- **Studio** — Storyboard / Video / Hyperframes (merged Phase 4)
- **Agents** — Approvals, Handoffs, Delegations, Runs, Cron, Reports
- **Files / Sessions / Settings** — workspace tools

## 4. Routes — `src/routes/` (TanStack file-based)

### Canonical (post-restructure)
- `mail/{inbox,triage,all,drafts}` + `mail/route.tsx` shell
- `outbox/{email,newsletter,social,sequences,sent}` + `outbox/route.tsx` shell
- `tasks`, `delegations`, `approvals`, `handoffs`
- `agent-runs`, `cron`, `reports`
- `calendar`, `finance/*`, `fundraising/*`
- `strategy`, `sales`, `partnerships`, `executive`, `features`, `content`
- `sessions`, `storyboard`, `video`, `settings`
- `/` (Home dashboard, Phase 5)

### Legacy (redirects, pending Phase 6 cleanup)
- `inbox/`, `emails/`, `triage/` → `/mail/*`
- `email-queue/*`, `newsletters/`, `newsletter-queue/` → `/outbox/*`
- `social/*`, `social-queue/` → `/outbox/social`

Restructure plan: `docs/nav-restructure-plan.md`.

## 5. Components

### UI primitives — `src/components/ui/` (shadcn/Radix, ~25)
accordion, alert, avatar, badge, button, button-group, card, carousel, command, dialog, dropdown-menu, hover-card, input, input-group, popover, progress, scroll-area, select, separator, sheet, spinner, switch, tabs, textarea, tooltip.

### Feature components
- `src/components/accounting/` — entity switcher
- `src/components/mbox/` — Thunderbird mailbox reader
- `src/components/ai-elements/` — Claude chat rendering
- `src/components/markdown.tsx`, `pa-actions-refresh-button.tsx`

### Shell-owned
- `src/shell/panes/*` — terminal/chat/viewer tabs incl. new-tab menu
- `src/shell/sessions/*` — Claude session list & editor

## 6. Dominant UI patterns

- **Data-dense tables** for finance, fundraising, sessions, mail lists
- **Sheet** detail views (right-edge drawer) for mail, finance rows
- **Command palette** as primary navigation accelerant
- **Side pane** (Terminal / Chat / Viewer) — collapsible, persistent
- **Sticky section tabs** for Mail/Outbox subsections
- **Iyke shimmer** activity overlay on panes (recently added)

## 7. Theming

- Tailwind CSS 4 via `@theme` block in `src/styles.css` (no `tailwind.config.ts`)
- 13 color tokens × {light, dark}; dark applied via `.dark` class (next-themes) + `prefers-color-scheme` fallback
- Single radius token (`0.5rem`)
- System sans stack (`ui-sans-serif, system-ui, …`) — no custom typeface yet
- Terminal pane: hard-coded `#000` background, xterm.js + WebGL

## 8. Known design debt

1. **Token surface is thin** — only 13 colors + 1 radius; no spacing/typography/elevation/motion scales.
2. **No typography system** — system font stack, no scale, no weights defined.
3. **No density scale** — data tables, mail lists, and finance rows each invent their own line-height/padding.
4. **Iconography is ad-hoc** — Lucide everywhere with default sizes/strokes; no rules.
5. **Mode switching feels uniform** — App/Mail/Studio/Agents look identical; no visual cue for the active "world."
6. **Light mode is undertuned** — most testing happens in dark; light tokens exist but UI hasn't been audited.
7. **Side pane presentation** — Terminal vs Chat vs Viewer use different conventions for headers, tabs, empty states.
8. **Shadcn defaults dominate** — almost no Royalti voice yet; this is a desktop cockpit, not a marketing site, so the visual identity needs intentional choices.

## 9. References inside the repo

- Architecture & conventions: `CLAUDE.md` (root)
- Phase 0 (PTY/xterm) report: `phase-0-report.md`
- Restructure roadmap: `docs/nav-restructure-plan.md`
- Theme tokens: `src/styles.css`
- Nav source of truth: `src/shell/nav-config.ts`, `src/shell/mini-apps-config.ts`
