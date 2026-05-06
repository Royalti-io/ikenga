# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`ikenga-desktop` is the Tauri 2 + Vite + React 19 + TypeScript desktop replacement for the (now-retired Next.js) `ikenga/` server. It is a single-window control plane for the Ikenga: terminals, Claude sessions, email/social/newsletter queues, viewers, and (ports in progress) the video engine and storyboard tools.

Migration plan + per-phase docs live in `.company/technical/plans/2026-04-30-pa-desktop-migration/`. Phase status is tracked in `README.md`.

## Common commands

```bash
bun install
bun run tauri dev          # full app (opens window, hot-reloads)
bun run dev                # Vite only — useful for component work without the Tauri shell
bun run typecheck          # tsc --noEmit (fastest correctness check)
bun run build              # typecheck + Vite build (bundles ./dist for Tauri to embed)
bun run tsr:generate       # regenerate src/routeTree.gen.ts after adding/renaming routes
bun run tsr:watch          # generate routes on file changes
bun run fmt                # biome format --write .
bun run lint               # biome lint .
bun run test               # vitest run  (bun run test:watch for watch mode)

# Sidecar binaries (compiled with bun, embedded in Tauri bundle)
bun run sidecars:build              # builds mbox + video-studio + hyperframes + storyboard
bun run sidecars:build:copy         # syncs hyperframes-projects then builds
bun run sync:hyperframes            # sync hyperframes-projects/ from monorepo

# Production builds (unsigned, personal-use install — see README.md)
bunx tauri build --target x86_64-unknown-linux-gnu && ./scripts/install-linux.sh
bunx tauri build --target aarch64-apple-darwin && ./scripts/install-mac.sh
```

Required env (`.env.local`): `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, optional `VITE_SUPABASE_USER_JWT`.

## Architecture

### Two halves: frontend (`src/`) and Rust core (`src-tauri/`)

The frontend is a TanStack Router file-based-routing React app. The Rust core (`src-tauri/src/lib.rs`) wires Tauri commands and owns long-lived state (PTYs, Claude sessions, render jobs, viewer HTTP server, sidecar processes, fs watchers, iyke control bridge). Everything the UI needs from the OS goes through `src/lib/tauri-cmd.ts` — that file is the **cross-team contract**; matching Rust commands live in `src-tauri/src/commands/`.

When adding a Tauri command:
1. Add the Rust handler in `src-tauri/src/commands/<area>.rs`, re-export from `commands/mod.rs`, register in `lib.rs` `invoke_handler`.
2. Add the typed wrapper in `src/lib/tauri-cmd.ts`.
3. Never call `invoke()` directly from components — always go through `tauri-cmd.ts`.

### Shell layout (`src/shell/`)

`workspace.tsx` is the PanelGroup root with persisted sizes (`lib/layout-state.ts` → SQLite). The window is: activity-bar / sidebar / content-pane / side-pane. The side pane has tabs (Terminal | Chat | Viewer | Off). Routes render into `content-pane.tsx` via `<Outlet />`. `command-palette.tsx` is ⌘K; `native-menu.ts` is Mac-only. `mini-apps-config.ts` and `nav-config.ts` define the activity-bar entries and routing.

### Routes (`src/routes/`)

File-based via TanStack Router. **Do not edit `src/routeTree.gen.ts` by hand** — run `bun run tsr:generate` after adding/renaming routes. Major sections: `mail/` (inbox/triage/drafts), `outbox/` (email/newsletter/sequences/social/sent), `email-queue/`, `social/`, `tasks`, `delegations`, `finance`, `agent-runs`, `cron`, `sessions`, `settings`. The `mail/` and `outbox/` trees are the canonical post-restructure paths (see `docs/nav-restructure-plan.md`); legacy routes under `inbox/`, `emails/`, `triage/`, `social-queue/`, `newsletter-queue/`, `newsletters/` are being phased out.

### Data layer

- **Supabase** (`src/lib/supabase.ts`) — same project as `ikenga/`. Reads use anon key; mutations go through the actions sidecar.
- **TanStack Query** for all server state. Query keys centralized in `src/lib/query-keys.ts`, factories in `src/lib/queries/`.
- **Local SQLite** via `tauri-plugin-sql` for desktop-only state (panel sizes, viewer recents, claude sessions index, render queue, mbox sync, storyboards). Migrations are SQL files in `src-tauri/migrations/0001..0006`, registered in `lib.rs`. **Add new migrations as the next-numbered file and register them in `lib.rs` — never edit existing ones.**

### Sidecars (`sidecars/`)

Each sidecar is a separate bun project that compiles to a single binary embedded in the Tauri bundle. They are spawned from Rust (`src-tauri/src/commands/`) and speak JSON over stdio.

| Sidecar | Purpose |
|---|---|
| `actions/` | All mutations + pollers (Resend, Listmonk, Twenty CRM, email/reply send, fundraising, sequence advance). Replaces the Next.js API routes. Subcommand-based; see `sidecars/actions/README.md`. Some subcommands are inline, others delegate via `tsx` to scripts in `ikenga/scripts/` (the retired Next.js app still hosts them as a shared library). |
| `mbox/` | Local Thunderbird mbox reader. |
| `video-studio/` | Remotion-based video studio. |
| `hyperframes/` | HyperFrames render server. |
| `storyboard/` | Storyboard editor server (port 3105 in dev). |

The actions sidecar logs every run to the Supabase `agent_runs` table — visible on `/cron`. Env loads from `PA_ACTIONS_ENV_FILE` → `~/.config/pa-actions/env` → `royalti-co/ikenga/.env` (transition fallback).

### Claude session integration

`src-tauri/src/claude/` + `commands/claude.rs` spawn `claude` CLI subprocesses, parse stream-json, persist sessions to SQLite (migration `0003_claude_sessions`) and read the on-disk session jsonl. Frontend surfaces at `/sessions`, `/sessions/by-agent/$agent`, `/sessions/$sessionId`. Requires `claude` on `$PATH`.

### Iyke control bridge

`src-tauri/src/iyke/` is an in-app RPC bridge that lets the CLI (and external tools) drive the running desktop UI — DOM queries, screenshots, network capture, query-cache reads. Used by the `iyke` skill and the `--screenshot=window|pane:<id>` CLI intercept (`lib.rs` short-circuits before Tokio starts so a second invocation never spawns a second app instance).

## Conventions

- **Package manager: bun.** Don't introduce npm/pnpm lockfiles in this project.
- **Formatter: Biome** (`biome.json`). Run `bun run fmt` before committing significant frontend changes.
- **Path alias: `@/*` → `src/*`** (see `tsconfig.json` + `vite.config.ts`).
- **No new files in `src/routes/` without regenerating** `routeTree.gen.ts`.
- **shadcn primitives** live in `src/components/ui/` (ported from `ikenga`); add new ones via the shadcn CLI rather than copying source.
- **State**: TanStack Query for server state, Zustand stores in `src/lib/shell/`, `src/lib/panes/`, etc. for client state.
- **Don't run `git reset` or modify `.env*` files** (per global memory).

## Cross-repo context

This project replaced `ikenga/` (Next.js). The Next.js *server* was retired 2026-05-02 (commit `1768b8f`), but `ikenga/scripts/` and `ikenga/lib/` remain as a shared library that the actions sidecar shells out to via `tsx`. Supabase migrations also still live there — use `supabase db push --linked` from `ikenga/` for schema changes (per global memory).

For broader monorepo conventions see `/home/nedjamez/royalti-co/CLAUDE.md`.
