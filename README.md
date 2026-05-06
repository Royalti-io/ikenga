# ikenga-desktop

> Tauri 2 + Vite + React 19 + TypeScript desktop app — the production replacement
> for `ikenga/` (Next.js). Houses terminals, chat, viewers, and (later) the
> video / storyboard tools, all behind a single window.

See `.company/technical/plans/2026-04-30-pa-desktop-migration/` for the full
migration plan and architecture.

## Phase status

| Phase | Status |
|---|---|
| 0 — Tauri + xterm + PTY spike | landed |
| 1 — Shell + routing + terminal | landed |
| 2 — Route parity (groups A/B/C + extras) | landed |
| 3 — Claude session integration | landed |
| 4 — Artifact viewer | landed |
| 5 — Chat adapter + ClaudeCliAdapter | landed |
| 6 — Video engine port | landed |
| 7 — Storyboard port | landed |
| 8 — macOS local build | landed |
| 9 — Linux local build | landed |
| 10 — Activity bar | landed |
| 11 — Iyke control bridge | landed |
| 12 — Multi-pane grid | landed |
| 13 — Detachable panes | not started |

Phase 5 ported the chat adapter and streaming input. Phase 6 added the
video engine port (Remotion-based studio sidecar, render queue, video
player UI under `/video`). Phase 7 added the storyboard editor (sidecar
on port 3105, storyboard SQLite tables, `/video-bespoke` integration).
The Ikenga design system is in progress in `design/` — concept screens
and shared tokens/primitives exist; porting into `src/` not started.

## Quickstart

Prereqs:

- macOS or Linux (webview deps as in phase 0 — `libwebkit2gtk-4.1-dev` etc.)
- Rust ≥ 1.77
- `bun` ≥ 1.1
- `claude` on `$PATH` (for the terminal panel)

```bash
cd ikenga-desktop
bun install
cp .env.example .env.local   # fill in VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY
bun run tauri dev
```

The window opens to `/inbox`. Three resizable panels: nav rail / content /
side pane (Terminal / Chat / Viewer / Off tabs).

`/inbox` lists actionable triaged emails (`triage_category in ('urgent',
'action_needed')` with `processed_at IS NULL`). `/tasks` lists open tasks
across all assignees, filterable by status. Both are read-only in phase 1 —
mutation flows arrive in phase 2.

## Required env vars

| Var | Purpose |
|---|---|
| `VITE_SUPABASE_URL` | Same project as `ikenga/` |
| `VITE_SUPABASE_ANON_KEY` | Same project anon key |
| `VITE_SUPABASE_USER_JWT` | Optional dev stub — pre-issued user JWT for impersonation; auth flow proper lands later |

## Scripts

```bash
bun run dev          # Vite only (no Tauri window — useful for component work)
bun run tauri dev    # Tauri dev (opens window, hot-reloads)
bun run typecheck    # tsc --noEmit
bun run build        # typecheck + Vite build (bundles ./dist for Tauri)
bun run tsr:generate # regenerate TanStack Router routeTree.gen.ts
bun run fmt          # biome format --write .
bun run lint         # biome lint .
```

## Layout

```
src/
├─ routes/                # file-based routes (TanStack Router)
│  ├─ __root.tsx          # mounts the workspace shell
│  ├─ index.tsx           # /  → redirect /inbox
│  ├─ inbox/index.tsx     # actionable email triage (Supabase)
│  ├─ tasks/index.tsx     # open tasks list (Supabase)
│  └─ …                    # delegations, finance, queues, sessions, settings
├─ shell/
│  ├─ workspace.tsx       # PanelGroup root + persistence
│  ├─ nav-rail.tsx
│  ├─ content-pane.tsx    # renders <Outlet />
│  ├─ side-pane.tsx       # tabs: Terminal | Chat | Viewer | Off
│  ├─ command-palette.tsx # ⌘K / Ctrl+K
│  └─ native-menu.ts      # Mac-only menu bar
├─ components/ui/         # shadcn primitives, ported from ikenga
├─ lib/
│  ├─ tauri-cmd.ts        # cross-team contract (rust-eng implements matching cmds)
│  ├─ supabase.ts
│  ├─ query-client.ts
│  ├─ theme.ts
│  ├─ platform.ts
│  └─ layout-state.ts     # SQLite-backed panel size persistence
├─ terminal/              # owned by terminal-eng
└─ main.tsx
```

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| ⌘K / Ctrl+K | Command palette |
| ⌘B / Ctrl+B | Toggle nav rail |
| ⌘\ / Ctrl+\ | Toggle side pane |
| ⌘T / Ctrl+T | New terminal (terminal-eng listens for `cmd:new-terminal`) |
| ⌘⇧T | New chat (phase 5) |
| ⌘R | Resume last session |

Native menu is wired Mac-only; on Linux/Windows the same items are reachable
via the command palette.

A **global summon shortcut** is registered on app start:

| Platform | Shortcut |
|---|---|
| macOS | ⌥Space (Option + Space) |
| Linux | Super + Space |

Pressing it from anywhere on the system shows / hides + focuses the Royalti
PA window.

## Local install (personal use)

Unsigned, no notarization, no auto-updater, no remote distribution. See
`.company/technical/plans/2026-04-30-pa-desktop-migration/09-phase-8-mac-packaging.md`
and `…/10-phase-9-linux-packaging.md` for the full rationale.

### Linux (Pop_OS! / Ubuntu — primary daily driver)

```bash
cd ikenga-desktop
bunx tauri build --target x86_64-unknown-linux-gnu
./scripts/install-linux.sh
```

Produces both an AppImage and a `.deb`. The install script copies the
AppImage to `~/Applications/ikenga.AppImage`, marks it executable, and
installs a `.desktop` entry under `~/.local/share/applications/` so the OS
launcher picks it up.

`.deb` fallback (system-managed, requires sudo):

```bash
sudo dpkg -i src-tauri/target/x86_64-unknown-linux-gnu/release/bundle/deb/ikenga_*.deb
ikenga
```

WebKit2GTK 4.1 is required (`libwebkit2gtk-4.1-dev` for build,
`libwebkit2gtk-4.1-0` at runtime). Pop_OS! 22.04+ and Ubuntu 24.04+ ship
this; older Ubuntu LTS does not.

If the webview crashes on startup with intel-iris HW accel issues, launch
with:

```bash
WEBKIT_DISABLE_COMPOSITING_MODE=1 ~/Applications/ikenga.AppImage
```

### macOS (Apple Silicon — verification deferred)

> ⚠️ The Mac build path is committed but **unverified on this Linux session**.
> The first time you boot a Mac, run through these steps and update the
> README if anything's different.

```bash
cd ikenga-desktop
bunx tauri build --target aarch64-apple-darwin
./scripts/install-mac.sh
```

Tauri produces an ad-hoc-signed `.app` (signed with `-`, no Apple Developer
ID). The install script copies it to `/Applications/Ikenga.app` and
strips the `com.apple.quarantine` xattr so Gatekeeper doesn't block first
launch. Open via Spotlight or:

```bash
open "/Applications/Ikenga.app"
```

Mac-only polish (cfg-gated, dormant on Linux) currently shipped:

- Window vibrancy (HudWindow material) on the main window
- `titleBarStyle: "Overlay"` + `hiddenTitle: true` for inset traffic lights;
  the frontend reserves the top-left ~80px so the lights don't overlap
- `set_dock_badge(label)` Tauri command for unread inbox count (frontend
  wiring lands later)

If you want a universal binary instead, override the target:

```bash
TAURI_TARGET=universal-apple-darwin bunx tauri build --target universal-apple-darwin
TAURI_TARGET=universal-apple-darwin ./scripts/install-mac.sh
```

### Re-build / upgrade

Re-run the same `bunx tauri build` + install script. The script wipes the
existing install before copying, so it's idempotent.

### What this install path does NOT do

- No code signing (no Apple Developer ID, no Linux signing)
- No notarization
- No auto-updater (`tauri-plugin-updater` is intentionally absent)
- No Snap, no Flatpak, no Mac App Store
- No remote artifact upload (no GCS, no GitHub Releases, no Cloudflare)
- No system-tray icon (deferred — global shortcut covers summon UX)
- No auto-add-to-startup (opt-in only via your OS's startup-apps config)

If `ikenga-desktop` ever needs to be installed by anyone other than the
maintainer, revisit signing / notarization / a real CI flow at that point.
