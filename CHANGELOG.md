# ikenga-desktop

## 0.2.6

### Patch Changes

- Grant the updater + process plugin ACL to the main window. The in-app app updater was dead-on-arrival in every prior build — plugin:updater|check was never allowed in capabilities/default.json, so the update check silently failed and About always said "up to date". First build that can self-update via the banner / About page.

## 0.2.5

### Patch Changes

- eb6d578: Fix the pkg update flow: updates are only offered for registry-source installs (builtins update with the shell; dev/local installs are a working tree), one failing pkg no longer silently aborts the rest of the batch, and failures now surface in danger banners on /packages and the auto-updater. Release manifests now include a `linux-x86_64-deb` entry so deb-installed shells can self-update (they previously downloaded the AppImage and rejected it after the progress bar completed).

## 0.2.4

### Patch Changes

- b1777dc: iyke bridge fixes: `/iyke/click` now reports the actual match result instead of a blind `ok:true`, supports click-by-accessible-name, and `/iyke/go` syncs the activity mode to the navigated route.
- b1777dc: Give each app pkg its own activity-bar mode. App pkgs (Suite, Tasks, …) previously borrowed App mode and their published menu clobbered the shell's main nav; now each pkg owns a dynamic `pkg:<id>` mode — its rail icon highlights when active, the sidebar renders the pkg's menu as that mode's body, and App mode (⌘1) always keeps Home/Sessions/Scratchpads/Todos/Cron. Deep links to `/pkg/<id>/…` re-sync the rail; a persisted mode for a since-uninstalled pkg reconciles back to App once the kernel snapshot loads (shell-store persist v13→14, migration preserves pkg modes). The iyke `/iyke/mode` endpoint accepts `pkg:` modes, and its stale Rust validator (which silently rejected `pkgs`/`ngwa`/`artifact-grid`) now mirrors the live core-mode set.
- b1777dc: Full-domain local-store schema gap-fill: embed migrations 0032–0041 (pure-ETL drift fix, `latest_account_balances` view + deterministic id-DESC tie-break, the 14 remaining business tables down-mapped from live Supabase introspection, and `content_performance_history`), bringing the embedded runner to 41 migrations and in line with the canonical ikenga.db. Also hide `visibility: hidden` registry entries (dev/test fixtures + scaffolds) from the default pkg catalog — they stay installable by exact name and keep update detection.

## 0.2.3

### Patch Changes

- Fix the Windows release build failing to compile (E0308 in `screenshot.rs`): the `#[cfg(target_os = "windows")]` window-capture branch passed the `CaptureOutcome` enum straight to `write_capture`, which expects a `CaptureResult`. Unwrap it via the same match the pane path uses (`Ok` → bytes; `Err`/`NativeCrop` → error). Windows-only regression from the 0.2.2 native-crop screenshot change — the macOS/Linux build legs couldn't catch it because the branch is `cfg`-gated, so CI is the only gate.

## 0.2.2

### Patch Changes

- Harden pane/pin screenshot capture so it can no longer freeze or crash the WebKitGTK renderer. Pane capture now prefers a native window-crop (capture the window via the OS tool, crop to the pane's rect with the `image` crate) and only falls back to the synchronous `modern-screenshot` DOM clone when the pane has its own off-screen content — and that fallback is gated by a node-count ceiling that declines cleanly instead of attempting a clone large enough to trip the JSC watchdog. Native-crop validates the captured PNG against the window's outer size before trusting the crop and caches an "unreliable" verdict per compositor (e.g. focus-dependent `gnome-screenshot -w`) so later captures skip the doomed probe. Also: Windows window-capture now falls back to the FE path instead of hard-erroring; the iyke screenshot CLI timeout is raised 15s→70s; and a dropped `log::warn!` in the global-shortcut registration is switched to `tracing::warn!`.
- Slim install size: stop bundling the ~89 MB Bun runtime in release artifacts (deb/AppImage/dmg/nsis) and resolve it at runtime instead (env `IKENGA_BUN_PATH` → version-gated system `bun` ≥ 1.3.14 → cached fetched bun with SHA-pin → post-launch background fetch with a progress chip; sha256-verified before unzip, no-strike park while fetching). Add `[profile.release]` strip + thin LTO so the binary itself is smaller across every target. The app boots and runs without bun; only bun-backed sidecars wait for the background fetch. Offline/air-gapped installs documented (system bun, drop-in binary, `IKENGA_BUN_PATH`).

## 0.2.1

### Patch Changes

- 1b22238: Slim install size: stop bundling the ~89 MB Bun runtime in release artifacts (deb/AppImage/dmg/nsis) and resolve it at runtime instead (env `IKENGA_BUN_PATH` → version-gated system `bun` ≥ 1.3.14 → cached fetched bun with SHA-pin → post-launch background fetch with a progress chip; sha256-verified before unzip, no-strike park while fetching). Add `[profile.release]` strip + thin LTO so the binary itself is smaller across every target. The app boots and runs without bun; only bun-backed sidecars wait for the background fetch. Offline/air-gapped installs documented (system bun, drop-in binary, `IKENGA_BUN_PATH`).
