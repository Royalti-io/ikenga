# Ikenga Desktop — Navigation Restructure Plan

**Status**: Phases 0–5 + Phase 7 complete (2026-05-03). Phase 6 cleanup partially complete (social + newsletter legacy routes deleted 2026-05-06).
**Started**: 2026-05-03
**Tracking**: see TaskList in active session; this doc is the canonical reference.

## Progress

- ✅ Phase 0 — Mail + Outbox shells with SectionTabs layouts
- ✅ Phase 1 — Outbox merge (Email/Newsletter/Social/Sequences/Sent + 12 redirects)
- ✅ Phase 2 — Mail merge (Triage/Inbox/All/Drafts under /mail + 5 redirects + /mail/$id detail)
- ✅ Phase 3 — Agents rail populated with Observability section (App-mode "Agents" group removed)
- ✅ Phase 4 — Studio rail merge (storyboard + video-engine + hyperframes → single Studio rail)
- ✅ Phase 5 — Real Home dashboard at / (replaces /inbox redirect)
- 🟨 Phase 6 — Cleanup (in progress)
  - ✅ 2026-05-06 — `/social-queue/*`, `/social/*`, `/newsletter-queue/*`, `/newsletters`, `/email-queue/newsletters`, `/email-queue/newsletter-sends` deleted outright (no redirect). Detail-page deep-link `?post=<id>` ported into `SocialQueuePage`. `email-queue/route.tsx` newsletter-sends tab removed. Verified: tsr:generate clean, tsc --noEmit clean, no source references remain.
- ✅ Phase 7 — Stub porting (executive/strategy/content/features/sales/partnerships) — simplified single-file ports against Supabase tables. Original Next.js components left behind in git history for future enhancement.

## Goal

Cut nav from **30 routes / 6 groups** to **~12 entries / 3 groups + 4 rail workspaces**. Eliminate duplicates, give each workspace one canonical home. **Stubs stay in nav** — they will be ported from the retired Next.js PA app.

Stub source: `ikenga@1768b8f^:app/{executive,strategy,content,features,sales,partnerships}/page.tsx` (commit `1768b8f` is "phase D — retire Next.js server"; `^` is the parent that still has the pages).

---

## Final shape

### Activity Bar (rail) — 7 modes

| Mode | Purpose | Status |
|---|---|---|
| **App** | Business ops (sidebar nav) | exists, trim |
| **Mail** | All email | NEW rail |
| **Studio** | Storyboard + Video + Hyperframes | merge 3 modes |
| **Agents** | Approvals/Handoffs/Delegations/Runs/Cron/Reports | exists, populate |
| **Files** | unchanged | — |
| **Sessions** | unchanged | — |
| **Settings** | unchanged | — |

### App-mode sidebar — final entries

```
(no group)
  Home            /                ← real dashboard, no redirect
  Calendar        /calendar
  Tasks           /tasks

Pipeline
  Strategy        /strategy        (stub — port from ikenga)
  Sales           /sales           (stub — port from ikenga)
  Partnerships    /partnerships    (stub — port from ikenga)
  Fundraising     /fundraising
  Finance         /finance

Outbox
  Email           /outbox/email
  Newsletter      /outbox/newsletter
  Social          /outbox/social
  Sequences       /outbox/sequences
  Sent            /outbox/sent

Product
  Executive       /executive       (stub — port from ikenga)
  Features        /features        (stub — port from ikenga)
  Content         /content         (stub — port from ikenga)
```

### Mail workspace (rail)
```
/mail
  ├─ Triage      (was /triage)
  ├─ Inbox       (was /inbox — actionable triaged)
  ├─ All         (was /emails)
  └─ Drafts      (was /emails/drafts)
```

### Studio workspace (rail)
```
studio-mode rail
  ├─ Storyboard   (was /storyboard)
  ├─ Compositions (was /video, /video/queue, /video/$id)
  └─ Hyperframes  (was hyperframes-mode placeholder)
```

### Agents workspace (rail)
```
agents-mode sidebar lists: Approvals · Handoffs · Delegations · Runs · Cron · Reports
Routes stay; nav moves out of App sidebar.
```

---

## Route migration table

| Old route(s) | New route | Action |
|---|---|---|
| `/` (redirect → /inbox) | `/` | Replace with real dashboard |
| `/inbox` | `/mail/inbox` | Move + redirect |
| `/emails` | `/mail/all` | Move + redirect |
| `/emails/$id` | `/mail/$id` | Move + redirect |
| `/emails/drafts` | `/mail/drafts` | Move + redirect |
| `/triage` | `/mail/triage` | Move + redirect |
| `/email-queue` | `/outbox/email` | Move + redirect |
| `/email-queue/$id` | `/outbox/email/$id` | Move + redirect |
| `/email-queue/approvals` | `/outbox/email?status=pending_review` | Collapse to filter |
| `/email-queue/sequences` | `/outbox/sequences` | Promote |
| `/email-queue/replies` | `/mail/drafts` | **Merge** — same data |
| `/email-queue/sent` | `/outbox/sent?type=email` | Collapse |
| `/email-queue/newsletters` | `/outbox/newsletter` | **Merge** with /newsletters |
| `/email-queue/newsletter-sends` | `/outbox/sent?type=newsletter` | Collapse |
| `/newsletters` | `/outbox/newsletter` | **Delete duplicate** |
| `/newsletter-queue` | `/outbox/newsletter` | **Delete duplicate** |
| `/newsletter-queue/$id` | `/outbox/newsletter/$id` | Move |
| `/social` | `/outbox/social` | **Delete** (older variant) |
| `/social-queue` | `/outbox/social` | Move |
| `/social-queue/$id` | `/outbox/social/$id` | Move |
| `/social/approvals` | `/outbox/social?status=pending` | Collapse |
| `/social/posted` | `/outbox/sent?type=social` | Collapse |
| `/storyboard/*`, `/video/*` | unchanged, surfaced via Studio rail | nav-only |
| `/approvals`, `/handoffs`, `/delegations`, `/agent-runs`, `/cron`, `/reports` | unchanged routes; **moved out of App sidebar** into Agents rail | nav-only |
| `/executive`, `/strategy`, `/content`, `/features`, `/sales`, `/partnerships` | unchanged routes; ported from ikenga | content swap |

---

## Phased execution

### Phase 0 — Foundation (no user-visible change)
1. Create `src/routes/mail/route.tsx` and `src/routes/outbox/route.tsx` shells with tab strips.
2. Add `MailTabs` and `OutboxTabs` mirroring `FinanceTabs` pattern.
3. Extend `NAV_GROUPS` type if needed.

### Phase 1 — Outbox merge
1. Build `/outbox/email` from `email-queue/index.tsx` + status-filter chips replacing `approvals` sub-route.
2. Build `/outbox/newsletter` from `newsletters/index.tsx` (richest of three).
3. Build `/outbox/social` from `social-queue/index.tsx` (newer pattern).
4. Build `/outbox/sent` unified log: union of `email_drafts.status='sent'`, `newsletter_sends`, `social_queue.status='posted'`. Filter by `type` param.
5. Build `/outbox/sequences` from `email-queue/sequences`.
6. Add redirects on old paths (`beforeLoad: () => throw redirect(...)`).
7. Update `NAV_GROUPS`.
8. Delete old route files in cleanup PR (Phase 6).

### Phase 2 — Mail merge
1. Move `/triage`, `/inbox`, `/emails`, `/emails/$id`, `/emails/drafts` → `/mail/*`.
2. Reconcile `/emails/drafts` vs `/email-queue/replies` — verify they hit same `email_drafts` rows.
3. Add Mail rail mode `mail-mode.tsx`.
4. Add redirects.

### Phase 3 — Agents rail
1. Populate `agents-mode.tsx` with Approvals · Handoffs · Delegations · Runs · Cron · Reports.
2. Routes unchanged.
3. Remove "Agents" group from `NAV_GROUPS`.

### Phase 4 — Studio merge
1. Replace `storyboard-mode.tsx`, `video-engine-mode.tsx`, `hyperframes-mode.tsx` with single `studio-mode.tsx` containing internal section selector.
2. Update `mini-apps-config.ts` and Activity Bar.
3. Routes unchanged.

### Phase 5 — Home dashboard
1. Replace `/` redirect with a real Home component:
   - Inbox count (urgent + action_needed unread)
   - Today's calendar
   - Pending approvals count
   - Outbox pending review count
   - Top 3 overdue tasks
   - Latest cron failures
2. Each card links into its workspace.
3. Update command palette deep-links.
4. Update keyboard shortcuts: ⌘1 App, ⌘2 Mail, ⌘3 Studio, ⌘4 Agents, ⌘5 Files, ⌘6 Sessions, ⌘, Settings.

### Phase 6 — Cleanup
1. Delete old route files (after redirects soak one release).
2. Update `native-menu.ts`, `__root.tsx`, `command-palette.tsx`.

### Phase 7 — Stub porting (parallelizable with 3–6)
Source: `git show 1768b8f^:ikenga/app/<page>/page.tsx`
1. `/executive` — CEO scorecard, cross-functional health, quarterly snapshot
2. `/strategy` — WIP slots, initiatives kanban, risk matrix, validation log
3. `/content` — ContentKanban / ContentCalendar / ContentTable / ContentDetail
4. `/features` — FeaturesKanban + /api/features
5. `/sales` — SalesKanban + SalesTable + ListmonkStats + /api/sales/*
6. `/partnerships` — PartnershipsKanban + /api/partnerships

Each page = its own PR. Port pattern:
- Read Next.js `page.tsx` from git history
- Read its components from `ikenga@1768b8f^:components/`
- Convert to TanStack Router file route
- Replace `/api/*` calls with direct Supabase queries (per phase D pattern)
- Reuse desktop UI primitives (`@/components/ui/*`)

---

## Risks & verifications

- **Email lifecycle filter bug pattern** (memory: `email_queue_status_lifecycle_bug.md`): audit 3 filter sites before collapsing approvals → status filter chip. Verify `claimForSending`, `send-scheduled.ts`, `email-send-all.md` cover same status set.
- **Redirects must use TanStack Router `beforeLoad: () => throw redirect()`**.
- **Don't delete + add in same PR** — ship redirect-first, delete next PR.
- **Activity Bar shortcut shift**: update `SHORTCUT_MAP` in `activity-bar.tsx`.
- **`agents-mode` populated before App sidebar Agents group removed**.
- **Outbox `/sent`** may need a Supabase view `v_outbox_sent` to keep client query simple.

---

## File-level inventory

### New files
- `src/routes/mail/route.tsx`, `src/routes/mail/{triage,inbox,all,drafts}/index.tsx`, `src/routes/mail/$id.tsx`
- `src/routes/outbox/route.tsx`, `src/routes/outbox/{email,newsletter,social,sent,sequences}/index.tsx`, `src/routes/outbox/{email,newsletter,social}/$id.tsx`
- `src/shell/sidebar-modes/mail-mode.tsx`, `studio-mode.tsx`
- `src/components/mail/mail-tabs.tsx`, `src/components/outbox/outbox-tabs.tsx`

### Modified
- `src/shell/nav-config.ts` (full rewrite)
- `src/shell/activity-bar.tsx` (Mail, Studio modes; shortcut map)
- `src/shell/mini-apps-config.ts`
- `src/lib/shell/shell-store.ts` (extend types)
- `src/routes/index.tsx` (real dashboard)
- `src/shell/command-palette.tsx`, `src/shell/native-menu.ts`

### Deleted (Phase 6)
- `src/routes/inbox/index.tsx`
- `src/routes/emails/{index,route,$id}.tsx`, `emails/drafts/index.tsx`
- `src/routes/triage/index.tsx`
- `src/routes/email-queue/{approvals,replies,newsletter-sends,sent,newsletters}/index.tsx`
- `src/routes/newsletters/index.tsx`
- `src/routes/newsletter-queue/{index,$id}.tsx`
- `src/routes/social/{index,route,approvals/index,posted/index}.tsx`
- `src/routes/social-queue/*` after move
- Old sidebar-mode files for storyboard/video/hyperframes after Studio merge

---

## PR sequence

1. **PR 1** — Phase 0 foundation (Mail/Outbox shells, no nav change yet)
2. **PR 2** — Phase 1 Outbox merge (+ nav update)
3. **PR 3** — Phase 2 Mail merge (+ nav update + Mail rail)
4. **PR 4** — Phase 3 Agents rail
5. **PR 5** — Phase 4 Studio merge
6. **PR 6** — Phase 5 Home dashboard + palette + shortcuts
7. **PR 7+** — Phase 7 stub ports (one PR per page)
8. **PR final** — Phase 6 cleanup deletes
