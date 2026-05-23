# Ikenga

> A composable, AI-augmented desktop workspace. The shell ships the window
> chrome and a pkg kernel — everything else (mini-apps, tool servers, engine
> adapters) is an independently installable **pkg**. Industry-agnostic by
> design; the shell carries no vertical assumptions.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

<!-- SCREENSHOT: docs/media/hero.png — full app window: Home canvas with a
     couple of widgets, a chat pane open on the right -->
![Ikenga desktop](docs/media/hero.png)

## What it is

`ikenga-desktop` is a Tauri 2 + Vite + React 19 + TypeScript desktop app — a
single-window control plane that hosts terminals, AI chat sessions, viewers,
and pkg-contributed mini-apps. It is **engine-optional**: the default AI engine
(Claude Code) ships as a pkg, so it updates independently of the shell, and the
shell runs without any engine at all.

The product is a *platform*, not a fixed feature set. At boot the kernel
discovers installed pkgs, validates each manifest, and registers what it
contributes — UI routes, MCP tool servers, sidecars, cron, skills. Build a pkg
for any workflow and mount it; the shell stays generic.

```
Pkgs (independently installable + updatable)
  ├─ UI pkgs       — iframe / webview mini-apps
  ├─ MCP pkgs      — headless tool servers
  ├─ CLI pkgs      — bundled sidecar binaries
  └─ Engine pkgs   — Claude Code adapter (default), alternatives later

Pkg Kernel (Rust + TS)  — manifest, lifecycle, scopes, IPC, updater
Shell Core              — chrome, identity, pkg manager UI
Tauri host              — SQLite, FS, native menu, secrets (Stronghold)
```

Ikenga is open source under **Apache-2.0** — both the platform and the
first-party pkgs. See [ADR-009](../docs/adr/009-monorepo-pkgs-all-open.md).

## How pkgs work

Each pkg is a self-contained directory: a `manifest.json` plus whatever it
contributes. The manifest is validated against the Zod schema in
[`@ikenga/contract`](../contract); the kernel registers each declared block
against the matching registry (UI routes, MCP servers, sidecars, cron, …).

UI pkgs mount as one of three kinds:

- **iframe** — served by the in-process content server (the common case).
- **webview** — a native child webview, for sites that block iframe embedding
  via CSP `frame-ancestors`.
- **component** — host-registered React route (built-ins only).

Authoring guides per archetype live in [`docs/pkg-patterns/`](../docs/pkg-patterns).
Develop with a live reload loop — no shell restart:

```bash
ikenga dev /path/to/your/pkg   # symlink-mount + watch; reload on save
```

<!-- GIF: docs/media/pkg-dev.gif — `ikenga dev` mounting a pkg, then an
     edit-on-save triggering an in-place reload in the running shell -->
![Hot-mounting a pkg](docs/media/pkg-dev.gif)

## Multi-engine chat

The chat layer is multi-engine ([ADR-013](../docs/adr/013-multi-engine-runtime-wire-protocols.md)).
The frontend sees **one wire** — ACP-shaped session updates — regardless of
which CLI backs a thread. Engine and model are selectable per turn via a
two-level Engine → Model picker. Each engine needs its CLI on `$PATH`.

<!-- SCREENSHOT: docs/media/chat-engine-picker.png — the two-level
     Engine→Model popover open in the chat composer -->
![Engine picker](docs/media/chat-engine-picker.png)

| Engine | Status | Auth |
|---|---|---|
| **Claude Code** | default | `claude login` / `ANTHROPIC_API_KEY` |
| **Gemini** | ACP passthrough | `gemini auth` / `GEMINI_API_KEY` |
| **Codex** | custom adapter | `codex login` / `OPENAI_API_KEY` |
| **cursor-agent** | scaffold only (runtime stubbed) | TBD |

## Quickstart

Prereqs:

- macOS or Linux (Linux needs WebKit2GTK 4.1 — `libwebkit2gtk-4.1-dev`)
- Rust ≥ 1.77
- `bun` ≥ 1.1
- `claude` on `$PATH` (for the default engine + terminal panel)

```bash
cd shell
bun install
bun run tauri dev
```

The window opens to the **Home** canvas — a free-form workspace of built-in and
pkg-contributed widgets. Navigate via the activity bar, sidebar, and command
palette (⌘K / Ctrl+K). The first-run **onboarding** flow handles account /
engine setup; no env file is required to launch.

### Optional env vars

No env vars are needed to start the app — connections are configured at runtime
through onboarding. For dev convenience you can pre-seed values in `.env.local`
(see `.env.example`):

| Var | Purpose |
|---|---|
| `VITE_SUPABASE_URL` | Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | Supabase anon key |
| `VITE_DEV_FORCE_STUB_AUTH` | Dev-only — bypass real auth |
| `VITE_SUPABASE_USER_JWT` | Dev-only — pre-issued user JWT for impersonation |

## Scripts

```bash
bun run tauri dev    # full app (opens window, hot-reloads)
bun run dev          # Vite only — component work without the Tauri shell
bun run typecheck    # tsc --noEmit (fastest correctness check)
bun run build        # typecheck + Vite build (bundles ./dist for Tauri)
bun run tsr:generate # regenerate routeTree.gen.ts after route changes
bun run fmt          # biome format --write .
bun run lint         # biome lint .
bun run test         # vitest run
bun run engine:smoke # probe gemini --acp + codex --json wires (no build needed)
```

`dev` and `build` first run bundle prereqs automatically (`bun:fetch`,
`iyke:bundle`, `artifact:bundle`, `iyke:mcp:build`) — no manual step needed.

## Layout

```
src/
├─ routes/                # file-based routes (TanStack Router)
│  ├─ __root.tsx          # mounts the workspace shell
│  ├─ index.tsx           # /  → Home canvas
│  ├─ artifacts/  claude/  packages.tsx  pkg/  projects/
│  ├─ sessions/  settings/  onboarding/  scratchpads.tsx  todos.tsx
│  └─ …
├─ shell/
│  ├─ workspace.tsx       # PanelGroup root + persisted sizes
│  ├─ activity-bar.tsx    # left activity rail
│  ├─ sidebar.tsx         # mode-aware sidebar
│  ├─ content-pane.tsx    # renders <Outlet />
│  ├─ command-palette.tsx # ⌘K / Ctrl+K
│  ├─ home/               # Home widget canvas
│  ├─ panes/              # side-pane tabs (Terminal | Chat | Viewer | Off)
│  ├─ onboarding/         # first-run + engine auth wizard
│  └─ native-menu.ts      # Mac-only menu bar
├─ components/ui/         # shadcn primitives
├─ lib/
│  ├─ tauri-cmd.ts        # UI↔OS contract (matching Rust cmds in src-tauri/)
│  ├─ supabase.ts  query-client.ts  query-keys.ts
│  └─ …
└─ main.tsx
```

The Rust core lives in `src-tauri/` (Tauri commands, PTYs, pkg kernel + sidecar
supervisor, iyke control bridge). Everything the UI needs from the OS goes
through `src/lib/tauri-cmd.ts` — never call `invoke()` directly from components.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| ⌘K / Ctrl+K | Command palette |
| ⌘B / Ctrl+B | Toggle sidebar |
| ⌘\ / Ctrl+\ | Toggle side pane |
| ⌘T / Ctrl+T | New terminal |
| ⌘⇧T | New chat |
| ⌘R | Resume last session |

Native menu is wired Mac-only; on Linux/Windows the same items are reachable via
the command palette. A **global summon shortcut** is registered on startup
(macOS ⌥Space, Linux Super+Space) — press it from anywhere to show / hide +
focus the Ikenga window.

## Status

Released builds are on the [Releases page](https://github.com/Royalti-io/ikenga/releases)
(current: v0.0.7). Active sprint and blockers live in the workspace
[`STATUS.md`](../STATUS.md).

## Distribution

Two release paths: **GitHub Actions** for cross-platform release builds, and
**local build + install scripts** for fast single-platform iteration.

### GitHub Actions (recommended for releases)

`.github/workflows/release.yml` runs on tag push (`v*`) and produces installers
for all four targets in parallel:

| Runner | Target | Output |
|---|---|---|
| `macos-latest` | `aarch64-apple-darwin` | `.dmg`, `.app.tar.gz` (Apple Silicon) |
| `macos-latest` | `x86_64-apple-darwin` | `.dmg`, `.app.tar.gz` (Intel) |
| `windows-latest` | `x86_64-pc-windows-msvc` | `.msi`, `.exe` |
| `ubuntu-22.04` | `x86_64-unknown-linux-gnu` | `.deb` (`.AppImage` — see caveat) |

```bash
git tag v0.0.1
git push origin v0.0.1   # → draft release on the Releases page
```

**Manual test build** (no tag): Actions tab → Release workflow → Run workflow.
Pick a single matrix leg (`linux-only` / `mac-arm-only` / …) to test fast
(~10 min vs ~25). Artifacts attach to the run; no release is published.

**Setup:** workspace sibling deps (`@ikenga/contract`, `@ikenga/tokens`, the
engine + mcp-iyke pkgs) are public Apache-2.0, so the default `GITHUB_TOKEN`
works out of the box. Only if you fork a sibling repo private do you need a
fine-grained PAT with read access to it, added as the `WORKSPACE_DEPS_PAT`
secret.

Caveats:
- macOS builds are **unsigned + un-notarized** (no Apple Developer ID). Users
  see Gatekeeper warnings; right-click → Open on first launch.
- Windows builds are **unsigned**. SmartScreen warns on first run.
- Linux `.AppImage` may fail because `linuxdeploy` runs `ldd` on the bundled
  bun-compiled binaries, which `ldd` can't parse. The `.deb` always succeeds.

### Local install (single platform)

Unsigned, no notarization, no auto-updater, no remote distribution.

#### Linux (Pop_OS! / Ubuntu)

```bash
cd shell
bunx tauri build --target x86_64-unknown-linux-gnu
./scripts/install-linux.sh
```

Wraps `sudo dpkg -i` against the produced `.deb`. Binary lands at
`/usr/bin/ikenga-desktop`, `.desktop` entry under `/usr/share/applications/`.
Idempotent re-run; uninstall with `sudo dpkg -r ikenga-desktop`. Requires
WebKit2GTK 4.1 (`libwebkit2gtk-4.1-0` at runtime — Pop_OS! 22.04+ / Ubuntu
24.04+ ship it). If the webview crashes on startup with HW-accel issues:

```bash
WEBKIT_DISABLE_COMPOSITING_MODE=1 ikenga-desktop
```

#### macOS (Apple Silicon)

> ⚠️ For releases, prefer GitHub Actions above. This local path is for fast
> iteration on a Mac dev machine.

```bash
cd shell
bunx tauri build --target aarch64-apple-darwin
./scripts/install-mac.sh
```

Tauri produces an ad-hoc-signed `.app`; the script copies it to
`/Applications/Ikenga.app` and strips the quarantine xattr so Gatekeeper
doesn't block first launch. For a universal binary, set
`TAURI_TARGET=universal-apple-darwin` and build that target instead.

### What we don't do yet

- No code signing (no Apple Developer ID, no Windows EV cert)
- No notarization
- No auto-updater (`tauri-plugin-updater` intentionally absent)
- No Snap, Flatpak, or Mac App Store
- No system-tray icon (global shortcut covers summon UX)

GitHub Releases (via the Actions workflow) is the supported remote distribution
channel. Revisit signing / notarization if Ikenga ever needs to be installed at
scale.

## Links

- [ADR-009](../docs/adr/009-monorepo-pkgs-all-open.md) — open-platform licensing decision
- [Pkg authoring guides](../docs/pkg-patterns) — per-archetype patterns + templates
- [`CLAUDE.md`](CLAUDE.md) — detailed architecture for contributors
- [`STATUS.md`](../STATUS.md) — current sprint
