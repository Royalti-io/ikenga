# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`ikenga-desktop` is the Tauri 2 + Vite + React 19 + TypeScript desktop app. It is a single-window control plane for the Ikenga: terminals, Claude sessions, email/social/newsletter queues, viewers, and (ports in progress) the video engine and storyboard tools.

Phase status is tracked in `README.md`.

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

File-based via TanStack Router. **Do not edit `src/routeTree.gen.ts` by hand** — run `bun run tsr:generate` after adding/renaming routes. Major sections: `mail/` (inbox/triage/drafts), `outbox/` (email/newsletter/sequences/social/sent), `email-queue/`, `social/`, `tasks`, `delegations`, `finance`, `agent-runs`, `cron`, `sessions`, `settings`. The `mail/` and `outbox/` trees are the canonical post-restructure paths; legacy routes under `inbox/`, `emails/`, `triage/`, `social-queue/`, `newsletter-queue/`, `newsletters/` are being phased out. Restructure plan (private): `<workspace>/plans/shell/docs/nav-restructure-plan.md`.

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

The actions sidecar logs every run to the Supabase `agent_runs` table — visible on `/cron`. Env loads from `PA_ACTIONS_ENV_FILE` → `~/.config/pa-actions/env`.

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

This project replaced an earlier Next.js predecessor. The Next.js *server* was retired 2026-05-02; some legacy scripts and a `lib/` directory in that predecessor still serve as a shared library that the actions sidecar shells out to via `tsx`. Supabase migrations also still live there — `supabase db push --linked` from the predecessor's directory is the path for schema changes.

## Pane mount model — current state (2026-05-11)

Captured during Phase 0 of the `pkg-browser` design. Read this before adding any pkg that wants to embed arbitrary remote pages, control a webview, or mount anything other than an iframe.

### Today: pkgs mount as iframes only

- `Manifest.ui.routes[].kind` accepts `"iframe"` and `"component"`. **No `"webview"` / `"child_webview"` kind exists.**
- Iframe routes are served by the in-process `pkg_content/` HTTP server and rendered by `src/components/pkg/pkg-iframe-host.tsx`. Resolution path: TanStack catch-all `routes/pkg/$pkgId/$.tsx` → `pkgKernelStatus().registries.ui_routes.entries` → `PkgIframeHost`.
- `component`-kind routes are recorded but render as `<PkgRouteUnmountable />` for non-builtins. Builtins (Tasks) bypass the catch-all by registering host routes directly.
- Per-iframe CSP and Permission-Policy can be declared in `Manifest.ui.csp` / `Manifest.ui.permissions` and are applied by `pkg_content` when serving the iframe document.

### Not-yet-built: child webviews

- `tauri.conf.json` declares **one window**. No multi-webview, no `WebviewWindowBuilder`/`WebviewBuilder` usage anywhere in `src-tauri/`. Only `commands/screenshot.rs` references `WebviewWindow` and only to read pixels from the existing main window.
- Tauri 2's multi-webview is stable in 2.x and doesn't require the old `unstable` flag, but the kernel exposes no `create_child_webview` / `eval_in_pane` / cookie-partition APIs to pkgs today. This is the load-bearing prerequisite for `pkg-browser` and any other pkg that needs to drive arbitrary external sites (iframes hit CSP `frame-ancestors` on Spotify-for-Artists, Bandcamp, partner portals, etc.).
- WebKitGTK on Linux (`libwebkit2gtk-4.1` per the deb deps), WKWebView on macOS, WebView2 on Windows. CDP is only reachable on WebView2 (Windows only) — `eval()` over Tauri IPC is the cross-platform surface.

### MCP runtime — two paths, both stdio JSON-RPC

The kernel runs every pkg-supplied MCP server as a stdio child:

- **Per-call** (`pkg/mcp_runtime.rs::call_tool`) — default. Spawn → handshake → `tools/call` → reap, every call. 5s wallclock. Cheap for stateless tools, wrong for sidecars with session state.
- **Long-lived** (`pkg/lifecycle.rs::SidecarSupervisor`) — opt in with `mcp[].lifecycle = "long-lived"` in the manifest. Spawned once on install/boot, multiplexed via JSON-RPC ids over a single child stdin/stdout. Full state machine (Spawning/Running/Crashed/Blocked/Parked/ShuttingDown), 3-strikes-in-60s circuit breaker, port-in-use detection (Blocked, no strike), `pkg://lifecycle` events.

`pkg-browser` will be `"long-lived"` because it owns per-pane state (refs, cookie partitions, pause flags). Cwd of the spawned MCP child is `install_path`; relative paths in `args` resolve against it.

### Registries

Live in `src-tauri/src/pkg/registries/`: `claude_assets`, `cron`, `iyke_routes`, `mcp`, `permissions`, `queries`, `settings`, `sidecars`, `ui_routes`. Plus the `SidecarSupervisor` itself (a `Registry` impl in `pkg/lifecycle.rs`).

Adding a new registry (e.g. `webview_panes` for `pkg-browser`):
1. Add `pkg/registries/webview_panes.rs` implementing the `Registry` trait (`name`, `register`, `unregister`, `snapshot`).
2. Re-export from `pkg/registries/mod.rs`.
3. Construct + push into the registries `Vec` in `lib.rs::run()::setup` (search for the existing `Kernel::new(...)` call).
4. The kernel handles boot replay, install/uninstall ordering, rollback on failure — registries don't need to think about lifecycle.

### Manifest extension points

`Manifest::CapabilitiesBlock` is the existing pattern for opt-in host-resolved capabilities (currently just Supabase URL/anon key threaded through the AppBridge handshake). A `webview` capability would slot in here. **Top-level `Manifest` has `deny_unknown_fields`**, so any new block (`ui.routes[].kind = "webview"`, `capabilities.webview`, etc.) must be added to `manifest.rs` *and* mirrored in `@ikenga/contract/src/manifest.ts` Zod schema in lockstep — same rule as the engine block.

### What this means for `pkg-browser` Phase 1

Phase 1 ("kernel: child-webview panes") is real net-new work, not just plumbing:

1. New Tauri commands in `commands/pkg_webview.rs`: `pkg_webview_create / destroy / navigate / eval / set_visible`. Backed by `WebviewWindowBuilder` / per-window webview API. Cookie partition keyed by an opaque jar id passed by the pkg.
2. New `WebviewPanesRegistry` in `pkg/registries/webview_panes.rs` — tracks `(pkg_id, pane_id) → webview handle`, cleans up on `unregister`.
3. New manifest variant: `ui.routes[].kind = "webview"` *or* a separate `webview_panes` block (TBD in Phase 2). Plus `capabilities.webview = { partitions: string[] }`.
4. Frontend: `src/components/pkg/pkg-webview-host.tsx` — a placeholder React component that asks the kernel to mount a child webview at its DOM rect, reposition on resize, destroy on unmount. The webview floats over the React tree natively.
5. Background-execution mitigations from Phase 0.5 (App Nap on macOS, `CoreWebView2Controller.IsVisible` on Windows) get applied here.

The macOS multi-webview rendering case is the highest-risk unknown. If `WebviewWindowBuilder` doesn't behave under WKWebView, fall back to a borderless OS window per pane positioned over the pane rect — same `eval`/cookie/MCP surface, worse UX.

## Phase 0.5 — background-execution spike runbook

The spike is wired into the running shell (not a separate Tauri app) so it inherits the real production webview, IPC layer, and OS integration. Tests the *main* webview (proxy for child-webview behavior on rows 2–5; row 1 of the matrix needs Phase 1's child-webview API to be testable at all).

**Files** (all gated `cfg(debug_assertions)` / `import.meta.env.DEV`, deleted after sign-off):
- `src-tauri/src/commands/bg_spike.rs` — Rust command pair (`bg_spike_run`, `bg_spike_reply`).
- `src/lib/tauri-cmd.ts` — `bgSpikeRun()` typed wrapper at the bottom.
- `src/lib/dev/bg-spike.ts` — installs `window.__bgSpikeReply` + `window.bgSpikeRun` console helpers.

### How it measures

Tauri 2's `WebviewWindow::eval` is fire-and-forget — host gets no direct timing back. So Rust evals a snippet that calls `window.__bgSpikeReply(nonce)` in the page; the FE hook invokes `bg_spike_reply(nonce)` back into Rust; Rust records `t1 - t0` as the round-trip. This is the same shape as the latency a `pkg-browser` MCP tool will experience, end-to-end.

### Matrix to run on each OS (macOS / Windows / Linux)

For each row, in DevTools console:

```js
// 60-second runs at 500ms cadence, 5s per-ping timeout. Pass a tag so the
// console output is greppable across runs.
await window.bgSpikeRun({ tag: 'focused' })          // Row baseline
// → minimize the Ikenga window with the OS chrome, wait 30s, then:
await window.bgSpikeRun({ tag: 'minimized' })        // Row 2
// → restore + focus another app for the full run:
await window.bgSpikeRun({ tag: 'backgrounded' })     // Row 3
// → screen off (close lid / xset dpms force off / Ctrl+Shift+Power on Mac)
//   for the full run; keep machine awake (caffeinate -dim on macOS,
//   `systemd-inhibit --what=sleep sleep 90` on Linux):
await window.bgSpikeRun({ tag: 'screen-off' })       // Row 4
// → laptop to sleep mid-run; on wake, the queued ping should resolve.
//   Documented as "queued, runs on wake" — no pass/fail metric.
```

Each call returns `{ intendedCount, completedCount, timeoutCount, p50Us, p95Us, p99Us, maxUs, … }`. Console output prints a one-line summary table.

### Pass/fail thresholds (per-OS, per-row)

| Row | Required | Threshold |
|---|---|---|
| `focused` | baseline RTT | p95 < 50ms |
| `minimized` | eval still works | p95 < 500ms, completedCount/intendedCount > 0.95 |
| `backgrounded` | no App Nap delay | p95 < 500ms, completedCount/intendedCount > 0.95 |
| `screen-off` | works degraded | p95 < 2000ms, no full hangs |
| `sleep` | queued | wake resolves the in-flight ping |

### Decision gate (after collecting all 3 OSes)

- **Green** (3 of 5 rows pass on all OSes, sleep documented): proceed to Phase 1 unmodified.
- **Yellow** (one or more OSes fail `minimized` only): proceed to Phase 1 + bake the keep-awake mitigation into the kernel (assert macOS `NSProcessInfo.beginActivity(.userInitiated)` / Windows `CoreWebView2Controller.IsVisible = true` while any browser MCP tool call is in flight). Document `pkg-browser` as "works while the app window is open."
- **Red** (any platform breaks `eval` round-trip when minimized even with mitigations): rescope. Either accept "open window only" as a hard limitation or bring forward `pkg-browser-cdp` so headless Chromium covers minimized/overnight workflows.

### After sign-off

Delete:
- `src-tauri/src/commands/bg_spike.rs`
- The `#[cfg(debug_assertions)]` blocks in `src-tauri/src/commands/mod.rs` referencing `bg_spike`
- The `#[cfg(debug_assertions)]` blocks in `src-tauri/src/lib.rs` (import + manage + handler entries)
- The `src/lib/dev/bg-spike.ts` file + the `import './bg-spike'` line in `src/lib/dev/index.ts`
- The "Phase 0.5 background-execution spike (debug-only)" section at the end of `src/lib/tauri-cmd.ts`

This section in CLAUDE.md stays — it's the architecture record.

### Phase 1 — child-webview kernel (landed 2026-05-12)

Commit `2de5db9` (Rust side); FE half is a separate follow-up commit.

**New modules**:
- `pkg/webview.rs` — `WebviewPanesRegistry` (implements `Registry`). Tracks `(pkg_id, pane_id) → tauri::Webview`. Read-locked for navigate/eval/set_rect; write-locked only for create/destroy. Cleanup on pkg uninstall is automatic via the `Registry::unregister` trait path. Cookie partition data persists across uninstall by design (re-install picks up logins, same as a normal browser).
- `pkg/keep_awake.rs` — defensive Yellow mitigations from Phase 0.5. `acquire(reason)` returns an `InflightGuard`; multiple concurrent calls share one macOS `NSProcessInfo.beginActivity(.UserInitiated)` via an `Arc<Weak>` singleton. `pin_visible()` is a no-op on Linux, asserts `CoreWebView2Controller.IsVisible = true` on Windows.
- `commands/pkg_webview.rs` — four Tauri commands (`pkg_webview_create / destroy / navigate / set_rect`). Each takes a keep-awake guard except `destroy` and `set_rect` (resize is always in-focus). `eval` is intentionally not exposed to the FE — only the kernel and pkg-MCP servers ever drive it.

**Cargo changes**:
- `tauri = { version = "2.1", features = ["unstable"] }` — `unstable` enables `Window::add_child` for in-window child webviews. Pinned to 2.1+ for the macOS multi-webview fix (Tauri PR #11616).
- `sha2`, `url` — direct deps for partition-id derivation and URL parsing.
- macOS target: `objc2 = "0.5"`, `objc2-foundation = "0.2"` for the App-Nap inhibitor.
- Windows target: `webview2-com = "0.33"` for the visibility hold.

**Manifest extension** (Rust + `@ikenga/contract`):
- New `capabilities.webview = { child_webviews: bool, partitions: string[] }` block. Required for any `kind: "webview"` route to mount.
- TS Zod now includes `'webview'` in the `UiRouteSchema.kind` enum (drift fix — Zod was also missing the existing `capabilities.supabase` block, restored in the same commit).

**Per-jar isolation strategy**:
- Linux WebKitGTK + Windows WebView2: `data_directory(PathBuf)` keyed by `app_data_dir/webjars/<pkg-slug>/<partition>/`.
- macOS 14+ WKWebView: `data_store_identifier([u8; 16])` derived from `sha256(pkg_id || '/' || partition)[..16]`.
- Inlined under `#[cfg(target_os = "macos")]` inside `WebviewPanesRegistry::create` rather than a generic-typed helper (Tauri's `WebviewBuilder` is generic over the Runtime; a separate helper fights the type chain).

**Capability check on create**:
- `pkg_capabilities` cache populated at `Registry::register` time. `create()` rejects with explicit errors if `child_webviews = false` or if the requested partition isn't in the declared list.

**What's still pending in Phase 1**:
- FE component (`PkgWebviewHost`) — in flight, separate commit.
- Route resolver branch on `kind: "webview"` in `routes/pkg/$pkgId/$.tsx` — same FE commit.
- Smoke test pkg (`pkgs/test-webview/`) drafted; runs after FE lands.

### Phase 1 — final per-OS architecture (2026-05-13)

After multiple Linux smoke tests, `pkg/webview.rs` was rewritten one more time as a **`cfg`-gated `PaneSurface` enum** so each OS uses the path it can actually do well:

| OS | Surface | Mechanism |
|---|---|---|
| **macOS** | In-window child webview | `Window::add_child(WebviewBuilder, pos, size)` — Tauri PR #11616 fixed multi-webview rendering on WKWebView in Nov 2024. True embed; behaves like an iframe but isn't subject to CSP `frame-ancestors`. |
| **Windows** | In-window child webview | Same `add_child` path as macOS. WebView2 composes the child into the host HWND at the requested rect. |
| **Linux WebKitGTK** | Borderless top-level `WebviewWindow`, parented to main, manually tracked via `on_window_event(Moved/Resized)` | `add_child` is broken on Linux (Tauri #10420 / #13071 / #11170 — wry's GTK box layout silently ignores explicit position+size). Wry docs explicitly mark `build_as_child` as "Linux X11 only" and the X11 path is broken too. No upstream fix in flight as of May 2026. |

**The split is invisible to callers**: `PaneSurface::{InWindow(Webview), TopLevel(WebviewWindow)}` is wrapped in a thin shim that delegates `navigate / eval / close / position / size / kind`. The Tauri commands and the FE host don't know which path is active. The `WebviewPaneStatus.surface_kind` field surfaces the active variant for debug.

**Smoke test result (Linux X11/XWayland, 2026-05-13)**: kernel logged `screen_pos=(333,148) size=(961,734)`, `xwininfo` confirmed matching `Tauri App` window at exactly those coords. Architecture works end-to-end. Visual UX caveats:
- On Linux the child is a separate top-level X11 window, parented and tracked, but appears as a free-floating rectangle (not "embedded inside the pane"). Documented limitation.
- Wayland positioning is silently ignored at the protocol level — launch with `GDK_BACKEND=x11` to use XWayland.
- macOS / Windows untested in this session — the `add_child` path is community-validated for those platforms.

**Long-term Linux fix** (deferred, see separate research session): vendor or upstream-PR a wry change that uses `GtkOverlay`/`GtkFixed` instead of `GtkBox` as the child-webview container. Discussion #1178 has the recipe; nobody has merged it. ~few hundred LOC, well-bounded.

### Findings — Linux WebKitGTK (2026-05-12)

Run on Linux 6.17 / WebKitGTK (`libwebkit2gtk-4.1`) on a ThinkPad T490s. 60s runs at 500ms cadence, 5s per-ping timeout. Same dev binary (`bun run tauri dev`) across all four rows.

| Row | done/intended | p50_ms | p95_ms | p99_ms | max_ms | timeouts |
|---|---|---|---|---|---|---|
| focused | 120/120 | 1.34 | 2.72 | 27.93 | 38.68 | 0 |
| minimized | 113/114 | 1.28 | 3.09 | 5.60 | 94.75 | 1 |
| backgrounded | 120/120 | 1.23 | 2.59 | 3.68 | 4.48 | 0 |
| screen-off | 120/120 | 1.34 | 2.95 | 6.46 | 6.74 | 0 |

**All four rows pass with margin.** Sub-3ms p95 across every state — focus / occlusion / screen state are essentially invisible to host-injected `eval`. The one timeout in `minimized` was the moment of the minimize animation itself; the next ping landed normally. The single 94ms `max_ms` in `minimized` is the same artifact.

**Decision: Green on Linux.** No keep-awake mitigation needed for this OS.

**Outstanding: macOS and Windows** were not run (no machine available this session). The original concerns — macOS App Nap and Windows WebView2 `TrySuspend` — apply to those engines, not WebKitGTK. Linux passing tells us the kernel + eval pipeline is sound but says nothing about the other two OSes.

### Recommendation: Phase 1 "defensive Yellow"

Proceed to Phase 1 as planned, but **bake the keep-awake mitigations in from day one** rather than waiting for macOS / Windows numbers. They're cheap, the kernel is small, and they remove a re-architecture risk if the macOS pass turns out worse:

- **macOS**: hold `NSProcessInfo.beginActivity(.userInitiated, reason: "Ikenga browser automation")` while any `pkg_webview_eval` call is in flight; release when the in-flight count drops to zero.
- **Windows**: set `CoreWebView2Controller.IsVisible = true` on browser-pkg-owned webviews even when the host window is minimized; don't honor `TrySuspend` on them.
- **Linux**: nothing (Green confirmed).

If a future macOS or Windows spike run shows the mitigations are sufficient, no rework. If they're not, we already have the right hooks in place to layer on the next mitigation (separate borderless window, etc.) without touching the public manifest / MCP surface.

### Notes / known minor issues from this run

- The "[bg_spike] reply hook not installed" warnings printed in the original spike output were a **cosmetic bug** in the Rust eval snippet (`X && X() || warn` evaluates the warn branch because `X()` returns `undefined`). Replies were still firing — that's how we got 120/120 in three of four rows. Fixed in the same commit as these findings; subsequent runs should be silent.
- The user ran `screen-off` on Linux Wayland despite the runbook suggesting to skip it (`xset dpms force off` doesn't work on Wayland). Result still passed cleanly, presumably via a system-menu lock or lid action that blanked the display without suspending the process. Documented as: screen-off works on Linux when you can get the screen off, regardless of the mechanism.
