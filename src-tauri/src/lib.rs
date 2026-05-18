mod agent_detect;
pub mod claude;
mod commands;
pub mod engines;
pub mod env_files;
mod fs_roots;
mod fs_watch;
mod iyke;
pub mod path_fix;
mod pkg;
mod pkg_content;
mod pty;
mod runtime;
pub mod vault_key;
mod viewer_server;

use std::sync::Arc;

use tauri::{Emitter, Manager};
// tauri-plugin-sql is loaded as a plugin (below) so the frontend's
// `@tauri-apps/plugin-sql` callers resolve, but it does NOT own the
// migration list — that lives in `commands::db::ensure_schema`.
use tokio::sync::Mutex;

use commands::db::PaDb;
use commands::screenshot::new_pending as new_screenshot_pending;
use commands::{
    chat_cancel, chat_fork_session, chat_initialize, chat_load_session, chat_new_session, chat_prompt,
    chat_respond_permission, chat_set_effort, chat_set_mode, chat_set_model, activity_pins_add,
    activity_pins_list, activity_pins_remove, activity_pins_reorder, activity_pins_resolve_artifact,
    activity_pins_touch_open, activity_sections_create, activity_sections_list,
    activity_sections_remove, activity_sections_update, backup_delete,
    backup_export, backup_import, backup_list, chat_thread_move, chat_threads_list_by_project,
    claude_asset_list_pins, claude_asset_pin, claude_asset_unpin, claude_assets_discover,
    claude_config_load, claude_config_read_file, claude_config_unwatch, claude_config_watch,
    claude_list_sessions, claude_read_jsonl, comment_create, comment_delete, comment_get,
    comment_list, comment_record_routing, comment_route, comment_set_status, db_exec, db_query,
    dev_bind_port, dev_release_port,
    fs_exists, fs_kind, fs_list, fs_mime, fs_mkdir, fs_read, fs_rename, fs_roots_add, fs_roots_list,
    fs_roots_remove, fs_roots_reset, fs_search, fs_trash, fs_unwatch, fs_watch, fs_write,
    iyke_dom_done, iyke_dom_query,
    iyke_endpoint, iyke_log_push, iyke_mcp_info, iyke_network_push, iyke_query_cache_done,
    iyke_set_shell, iyke_terminal_read_done,
    iyke_wait_done, pin_screenshot_write, pkg_content_html, pkg_content_revoke, pkg_content_url, pkg_db_diag,
    pkg_discover_workspace, pkg_install_from_path, pkg_install_from_registry, pkg_kernel_status,
    pkg_mcp_call, pkg_preview_manifest, pkg_screenshot, pkg_set_enabled, pkg_set_scope, pkg_settings_get,
    pkg_settings_set, pkg_sidecar_call, pkg_supervisor_restart, pkg_uninstall, pkg_webview_create,
    pkg_webview_destroy, pkg_webview_navigate, pkg_webview_set_rect, project_archive,
    project_artifacts_walk, project_create, project_get_active, project_inventory, project_list,
    project_scaffold_claude, project_set_active, project_skills_list, project_update,
    pty_foreground, pty_foreground_snapshot, pty_kill, pty_resize, pty_spawn, pty_write,
    screenshot_capture_done, screenshot_capture_failed,
    screenshot_get_config, screenshot_pane, screenshot_set_dir, screenshot_window, secrets_delete,
    secrets_delete_scoped, secrets_get, secrets_get_scoped, secrets_list_keys,
    secrets_list_keys_scoped, secrets_set, secrets_set_scoped, secrets_vault_status, set_dock_badge,
    settings_clear_all, settings_get, settings_get_all, settings_set, spike_grant_fs_read,
    spike_setup_test_file, studio_message_append, studio_message_list, studio_thread_delete,
    studio_thread_get, studio_thread_get_or_create, studio_thread_list_recent, KernelState,
    PkgContentState, PkgSettingsState, SidecarSupervisorState, SidecarsRegistryState,
    WebviewPanesState,
};
#[cfg(debug_assertions)]
use commands::{bg_spike_reply, bg_spike_run, new_bg_spike_state};
use commands::{
    pkg_permission_violations_clear, pkg_permission_violations_list, pkg_trust_approve,
    pkg_trust_grant, pkg_trust_list, pkg_trust_list_pending, pkg_trust_preview, pkg_trust_reject,
    pkg_trust_revoke, session_cancel, session_destroy, session_destroy_all, session_ensure,
    session_send, session_tool_result, supabase_config_clear, supabase_config_get,
    supabase_config_set, viewer_port, viewer_serve, viewer_stop, IykeRuntimeState,
    ScreenshotConfigState, ScreenshotConfigStateRef, ScreenshotPending, SecretsLock,
};
use fs_watch::FsWatchManager;
use iyke::{IykeRpc, IykeState};
use pty::PtyManager;
use viewer_server::ViewerServerManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // CLI intercept: if invoked with --screenshot=window or --screenshot=pane:<id>,
    // talk to the already-running app over its iyke control bridge and exit.
    // Runs before Tokio/Tauri initialize so a second invocation never starts a
    // second instance.
    if let Some(arg) = parse_screenshot_arg(std::env::args()) {
        std::process::exit(run_screenshot_cli(arg));
    }

    init_logging();

    // Repair $PATH on macOS GUI launches (Dock/Finder/Spotlight inherit
    // launchd's minimal env, missing user-installed tools like `claude`).
    // Must run before any sub-process spawns inherit our env.
    path_fix::apply();

    let pty_manager = Arc::new(PtyManager::new());
    let fs_watch_manager = Arc::new(FsWatchManager::new());
    let viewer_manager = Arc::new(ViewerServerManager::new());
    let viewer_manager_for_start = viewer_manager.clone();
    let sessions_manager: claude::session::SessionsState =
        Arc::new(claude::session::SessionsManager::new());
    // ACP server shares the same `SessionsManager` so the legacy
    // `session_*` commands and the new ACP path operate on the same in-
    // memory session table. Phase 11 retires the legacy path.
    let claude_code_engine: engines::claude_code::server::ClaudeCodeEngineState =
        Arc::new(engines::claude_code::server::ClaudeCodeEngine::new(sessions_manager.clone()));
    // Phase 2: Gemini ACP engine. Spawns the `gemini --experimental-acp`
    // child lazily on first new_session per thread; one child per
    // threadId, reused across prompts.
    let gemini_acp_engine: engines::gemini_acp::GeminiAcpEngineState =
        Arc::new(engines::gemini_acp::GeminiAcpEngine::new());
    // Phase 3: Codex PTY engine. Lazy-spawns the `codex` CLI in a PTY on
    // first prompt per thread. Shares the global `PtyManager` so codex
    // children show up in pty diagnostics alongside the rest of the
    // shell's PTY surface.
    let codex_pty_engine: engines::codex_pty::CodexPtyEngineState =
        Arc::new(engines::codex_pty::CodexPtyEngine::new(pty_manager.clone()));
    // Multi-engine dispatcher used by `commands/chat.rs`. Built once
    // here and `.manage()`d so every Tauri command resolves engines
    // through the same registry.
    let engine_registry: engines::EngineRegistryState = Arc::new(engines::EngineRegistry::new());
    {
        let reg = engine_registry.clone();
        let claude_handle = engines::EngineHandle::ClaudeCode(claude_code_engine.clone());
        let gemini_handle = engines::EngineHandle::GeminiAcp(gemini_acp_engine.clone());
        let codex_handle = engines::EngineHandle::CodexPty(codex_pty_engine.clone());
        tauri::async_runtime::block_on(async move {
            reg.insert("claude-code", claude_handle).await;
            reg.insert("gemini", gemini_handle).await;
            reg.insert("codex", codex_handle).await;
        });
    }
    let screenshot_pending: ScreenshotPending = new_screenshot_pending();

    // Migrations are the responsibility of `commands::db::ensure_schema`
    // (the Rust-side sqlx runner). The tauri-plugin-sql migration path only
    // fires when JS calls `Database.load()` and that path has been observed
    // to silently hang (see workspace.tsx::raceTimeout); previously this
    // file maintained a parallel migration list that ran in zero practical
    // contexts. The plugin is still registered so frontend callers of
    // `@tauri-apps/plugin-sql` (Database.load for ad-hoc reads) work; it
    // just doesn't own the schema.

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(global_shortcut_plugin())
        .plugin(tauri_plugin_clipboard_manager::init())
        // Phase 9 (ACP migration): OS notifications for the
        // user-attention hooks (Notification + PermissionRequest). The
        // frontend dispatcher (`src/lib/notifications/acp-notify-bridge.ts`)
        // owns the focus-suppression policy and fires sendNotification
        // through this plugin's JS surface.
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(
            tauri_plugin_stronghold::Builder::new(|_password: &str| {
                // Phase 14: vault key is bootstrapped from the OS keychain.
                // The plugin's `_password` is ignored — we always pass an
                // empty string from the Rust side and the keychain is the
                // single source of truth. If the keychain is unavailable the
                // callback returns an empty Vec; Stronghold::new will fail
                // and the secrets_vault_status command surfaces the error to
                // the UI.
                vault_key::fetch_or_create().unwrap_or_else(|e| {
                    log::error!("vault key bootstrap failed: {e}");
                    Vec::new()
                })
            })
            .build(),
        )
        .manage(pty_manager)
        .manage(fs_watch_manager)
        .manage(viewer_manager)
        .manage(sessions_manager)
        .manage(claude_code_engine)
        .manage(gemini_acp_engine)
        .manage(codex_pty_engine)
        .manage(engine_registry)
        .manage(screenshot_pending.clone())
        .manage(SecretsLock::new())
        .setup(move |app| {
            // Resolve the bundled Bun (per ADR-010) before anything spawns
            // sidecars or MCP children. Idempotent; safe even if the binary
            // is missing — `runtime::resolve_command` then falls back to
            // PATH lookup with a warning.
            runtime::init_from_app(&app.handle());

            // Ensure app data dir exists; SQLite + Stronghold both write here.
            let data_dir = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("app_data_dir: {e}"))?;
            std::fs::create_dir_all(&data_dir)?;

            // User-configurable FS allowlist. Must be installed before the
            // first call to `commands::resolve_allowlisted` (which fs_*,
            // viewer_serve, and a handful of other commands depend on).
            match fs_roots::FsRoots::load(data_dir.join("fs_roots.json")) {
                Ok(roots) => {
                    let arc = Arc::new(roots);
                    if let Err(e) = fs_roots::install(arc) {
                        log::error!("[fs_roots] install failed: {e:#}");
                    }
                }
                Err(e) => log::error!("[fs_roots] load failed: {e:#}"),
            }

            // If the user staged a backup restore last session, swap pa.db
            // now — before any pool opens. apply_staged_restore_if_present
            // also wipes -wal/-shm sidecars so SQLite re-derives them
            // against the restored snapshot.
            match commands::backup::apply_staged_restore_if_present(&data_dir) {
                Ok(true) => log::info!("[backup] staged restore applied this boot"),
                Ok(false) => {}
                Err(e) => log::error!("[backup] staged restore failed: {e}"),
            }

            // Db wrapper points at the same file the plugin manages.
            let db_path = data_dir.join("pa.db");
            let pa_db = Arc::new(PaDb::new(db_path));
            app.manage(pa_db.clone());

            // Phase 1 (projects-first-class): expire-and-delete sweeper for
            // iyke_locks. 30s cadence; cheap.
            iyke::memory::spawn_lock_sweeper(pa_db.clone());

            // Phase 1: timer firing loop. Shares a `TimerScheduler` notify
            // handle with the iyke axum router so timer/schedule and
            // timer/cancel wake the loop without polling.
            let timer_scheduler = iyke::memory::TimerScheduler::new();
            iyke::memory::spawn_timer_fire_loop(
                pa_db.clone(),
                timer_scheduler.clone(),
                app.handle().clone(),
            );

            // Phase 2 of staged-restore: replay the decrypted secrets blob
            // (if present) into Stronghold. Runs after SecretsLock is in
            // state (registered via .manage() above on the Builder) and
            // after pa.db has been swapped. Stronghold opens lazily inside
            // bulk_set, so no extra wiring is needed here.
            commands::backup::apply_staged_secrets(app.handle());

            // Phase 3 of staged-restore: rewrite ${IKENGA_HOME} → current
            // $HOME in the eight path-bearing columns. Independent of
            // secrets; safe to call unconditionally.
            commands::backup::apply_staged_path_rewrites(app.handle());

            // User-overridable screenshot output dir. JSON-backed; loaded
            // synchronously here so the first capture sees the right value.
            let screenshot_cfg: ScreenshotConfigStateRef =
                Arc::new(ScreenshotConfigState::load(&data_dir));
            app.manage(screenshot_cfg);

            log::info!("ikenga app data dir: {}", data_dir.display());

            if let Err(e) = register_summon_shortcut(app.handle()) {
                log::warn!("global shortcut not registered (continuing): {e}");
            }
            register_screenshot_shortcuts(app.handle());

            // Iyke (Phase 11): localhost control bridge. Boot synchronously so
            // the server is ready by the time the webview asks for its
            // endpoint via `iyke_endpoint`. block_on is safe here — setup
            // runs outside any tokio runtime.
            let iyke_state = Arc::new(IykeState::new());
            let iyke_rpc = IykeRpc::new();
            let browser_rpc = iyke::BrowserRpc::new();
            let local_data_dir = app
                .path()
                .app_local_data_dir()
                .map_err(|e| format!("app_local_data_dir: {e}"))?;
            let control_path = local_data_dir.join("control.json");

            // Build the iyke routes registry *before* iyke::start so the
            // axum router gets a handle to it. Same Arc passes to the
            // kernel further down — register/unregister mutate it live.
            let iyke_routes_reg = Arc::new(pkg::registries::IykeRoutesRegistry::new());

            // Webview-panes registry: tracks pkg-owned child webviews; cleanup
            // runs on uninstall so pkgs can't leave orphan browser surfaces
            // behind. Constructed before iyke::start so the pkg-browser HTTP
            // bridge handlers can hold an Arc to it via an Extension layer.
            let webview_panes_reg = Arc::new(pkg::webview::WebviewPanesRegistry::new());

            let iyke_state_for_start = iyke_state.clone();
            let iyke_rpc_for_start = iyke_rpc.clone();
            let browser_rpc_for_start = browser_rpc.clone();
            let webview_panes_for_start = webview_panes_reg.clone();
            let pa_db_for_iyke = pa_db.clone();
            let app_handle_for_iyke = app.handle().clone();
            let pending_for_iyke = screenshot_pending.clone();
            let iyke_routes_for_start = iyke_routes_reg.clone();
            let timer_scheduler_for_start = timer_scheduler.clone();
            let runtime = tauri::async_runtime::block_on(async move {
                iyke::start(
                    iyke_state_for_start,
                    iyke_rpc_for_start,
                    browser_rpc_for_start,
                    webview_panes_for_start,
                    pa_db_for_iyke,
                    control_path,
                    app_handle_for_iyke,
                    pending_for_iyke,
                    iyke_routes_for_start,
                    timer_scheduler_for_start,
                )
                .await
            })
            .map_err(|e| format!("iyke start: {e:#}"))?;

            app.manage(iyke_state);
            app.manage(iyke_rpc);
            app.manage(browser_rpc);
            let runtime_state: IykeRuntimeState = Arc::new(Mutex::new(Some(runtime)));
            app.manage(runtime_state);

            // pkg kernel: stand up the registries, wire AppHandle in, and
            // expose under Tauri state. boot() is a no-op today but lands the
            // call site so the SQLite-backed install path drops in cleanly.
            let sidecars_reg = Arc::new(pkg::registries::SidecarsRegistry::new());
            let perms_reg = Arc::new(pkg::registries::PermissionsRegistry::new(
                app.handle().clone(),
                pa_db.clone(),
            ));
            let settings_reg = Arc::new(pkg::registries::SettingsRegistry::new(pa_db.clone()));
            let cron_reg = Arc::new(pkg::registries::CronRegistry::new(
                app.handle().clone(),
                sidecars_reg.clone(),
            ));
            let ui_routes_reg = Arc::new(pkg::registries::UiRoutesRegistry::new());
            let claude_assets_reg = Arc::new(pkg::registries::ClaudeAssetsRegistry::new());
            let mcp_reg = Arc::new(pkg::registries::McpRegistry::new());
            let queries_reg = Arc::new(pkg::registries::QueriesRegistry::new());
            // `webview_panes_reg` was already constructed above (before iyke::start)
            // so the HTTP bridge handlers can hold an Arc to it. It also feeds the
            // kernel registry list further down — same Arc, so cookie-partition
            // cleanup on uninstall still flows through `Registry::unregister`.
            // Sidecar supervisor: itself a Registry, owns long-lived MCP
            // children for any pkg with `mcp[].lifecycle = "long-lived"`.
            // Held separately as an Arc so `pkg_mcp_call` can dispatch to it
            // without going through the kernel snapshot.
            let sidecar_supervisor = Arc::new(
                pkg::SidecarSupervisor::with_app(app.handle().clone())
                    .with_db(pa_db.clone()),
            );
            let pkg_content_server = pkg_content::PkgContentServer::new();
            // Bind the content server before the kernel boots so that
            // boot-replay's `register()` calls find an already-running server
            // ready to serve. Failure here is non-fatal — iframe mounts will
            // surface the error via mint() instead of the app refusing to
            // start.
            let pkg_content_for_start = pkg_content_server.clone();
            if let Err(e) = tauri::async_runtime::block_on(async move {
                pkg_content_for_start.start().await
            }) {
                log::warn!("[pkg_content] start failed (continuing): {e:#}");
            }

            // Viewer-server: single shared axum bound at startup so every
            // artifact iframe is same-origin with the shell (Vite proxies
            // /__viewer/* to it in dev; in prod the shell loads directly from
            // this server via the programmatic WebviewWindowBuilder below,
            // and the server's catch-all serves the bundled frontend dist via
            // Tauri's `AssetResolver`). The bound port is captured here and
            // threaded into the window URL — if the preferred port (47821) is
            // in use (e.g. a concurrent debug instance), the server falls back
            // to an OS-chosen port and the window still finds it.
            let viewer_for_start = viewer_manager_for_start.clone();
            let viewer_app_handle = app.handle().clone();
            let viewer_port = tauri::async_runtime::block_on(async move {
                viewer_for_start.start(&viewer_app_handle).await
            })
            .map_err(|e| {
                tracing::error!("[viewer] start failed: {e:#}");
                e
            })?;

            // Main window — built programmatically so the prod webview loads
            // from our viewer-server (same origin as `/__viewer/*` iframes,
            // which is what makes `iframe.contentDocument` work for Studio's
            // comment-mode, modern-screenshot, and the iyke iframe bridge).
            // In dev, Vite serves the shell at :1420; in prod the
            // viewer-server's catch-all serves the bundled dist at
            // `viewer_port`. The label "main" matches the capability target
            // in `capabilities/default.json`; `remote.urls` there grants IPC
            // trust to both candidate localhost URLs.
            #[cfg(debug_assertions)]
            let window_url = "http://localhost:1420/".to_string();
            #[cfg(not(debug_assertions))]
            let window_url = format!("http://localhost:{viewer_port}/");
            let url: tauri::Url = window_url.parse().expect("static window URL");
            let builder = tauri::WebviewWindowBuilder::new(
                app.handle(),
                "main",
                tauri::WebviewUrl::External(url),
            )
            .title("Ikenga")
            .inner_size(1280.0, 800.0)
            .min_inner_size(960.0, 600.0)
            .resizable(true);
            // Overlay title-bar + hidden title are macOS-only; the rest of
            // the window config applies on every platform.
            #[cfg(target_os = "macos")]
            let builder = builder
                .title_bar_style(tauri::TitleBarStyle::Overlay)
                .hidden_title(true);
            builder.build()?;
            let kernel = Arc::new(pkg::Kernel::new(
                app.handle().clone(),
                pa_db.clone(),
                vec![
                    sidecars_reg.clone() as Arc<dyn pkg::Registry>,
                    perms_reg as Arc<dyn pkg::Registry>,
                    iyke_routes_reg as Arc<dyn pkg::Registry>,
                    settings_reg.clone() as Arc<dyn pkg::Registry>,
                    cron_reg as Arc<dyn pkg::Registry>,
                    ui_routes_reg as Arc<dyn pkg::Registry>,
                    claude_assets_reg as Arc<dyn pkg::Registry>,
                    mcp_reg as Arc<dyn pkg::Registry>,
                    queries_reg as Arc<dyn pkg::Registry>,
                    webview_panes_reg.clone() as Arc<dyn pkg::Registry>,
                    pkg_content_server.clone() as Arc<dyn pkg::Registry>,
                    sidecar_supervisor.clone() as Arc<dyn pkg::Registry>,
                ],
            ));
            if let Err(e) = kernel.boot() {
                log::warn!("[pkg_kernel] boot failed (continuing): {e:#}");
            }
            // Auto-install bundled built-in packages (com.ikenga.iyke, …).
            // Skips anything already in pkg_installed, so this runs every
            // boot but only does work on first launch / after uninstall.
            //
            // Two candidate sources, tried in order:
            //   1. The Tauri bundled resource dir (prod builds — populated
            //      from `tauri.conf.json:bundle.resources`).
            //   2. `$CARGO_MANIFEST_DIR/resources/` (dev — bundled resources
            //      aren't copied into target/ during `tauri dev`, so we read
            //      the source tree directly via the compile-time env var).
            // First one with a `builtin-pkgs/` subdir wins.
            // In debug builds, read from the source tree so editing a built-in
            // pkg's skill / command is live without rebuilding the bundle.
            // In release builds, the Tauri-bundled resource_dir is the only
            // sane source — but the glob shape in `tauri.conf.json:resources`
            // dictates the exact subpath, so prefer the source-tree path
            // unless we're in a release build with no source tree available.
            let mut builtin_root: Option<std::path::PathBuf> = None;
            #[cfg(debug_assertions)]
            {
                let dev_root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("resources");
                if dev_root.join("builtin-pkgs").is_dir() {
                    builtin_root = Some(dev_root);
                }
            }
            if builtin_root.is_none() {
                if let Ok(resource_dir) = app.path().resource_dir() {
                    if resource_dir.join("builtin-pkgs").is_dir() {
                        builtin_root = Some(resource_dir);
                    }
                }
            }
            match builtin_root {
                Some(root) => {
                    if let Err(e) = kernel.install_builtins(&root) {
                        log::warn!("[pkg_kernel] builtins install failed (continuing): {e:#}");
                    }
                }
                None => log::info!("[pkg_kernel] no builtin-pkgs/ found in resource_dir or CARGO_MANIFEST_DIR/resources"),
            }
            // Pick up pkgs that landed in <app_data_dir>/pkgs/ while the shell
            // was offline — typically CLI-installed pkgs (`ikenga add ...`).
            // Idempotent: already-tracked entries are skipped. Runs after the
            // boot replay + builtin install so it only sees genuinely new dirs.
            if let Err(e) = kernel.install_from_pkgs_dir() {
                log::warn!("[pkg_kernel] pkgs-dir discovery failed (continuing): {e:#}");
            }
            // Phase 2 (projects-first-class): seed the live set from the
            // boot-registered pkgs, then reconcile against the active
            // project so anything scoped to a non-active project is parked
            // on first paint. boot() registered every enabled row; we
            // mark them live, then prune.
            kernel.mark_all_live();
            {
                let db_for_active = pa_db.clone();
                let active_now = tauri::async_runtime::block_on(async move {
                    let pool = db_for_active.ensure_pool().await.ok()?;
                    crate::commands::projects::get_active_project_id(&pool).await.ok()
                });
                if let Some(active) = active_now {
                    if let Err(e) = kernel.reconcile_for_project(&active) {
                        log::warn!("[pkg_kernel] initial reconcile failed (continuing): {e:#}");
                    }
                }
            }
            let kernel_arc_for_listener = kernel.clone();
            app.manage(KernelState(kernel));
            app.manage(PkgSettingsState(settings_reg));
            app.manage(PkgContentState(pkg_content_server));
            app.manage(SidecarSupervisorState(sidecar_supervisor));
            app.manage(SidecarsRegistryState(sidecars_reg));
            app.manage(WebviewPanesState(webview_panes_reg));

            // Phase 2 (projects-first-class): subscribe to
            // `projects:active-changed` and reconcile pkg liveness on
            // every switch. Debounced 250ms because rapid ⌘P spamming
            // through the picker emits one event per step.
            {
                use tauri::{Listener, Manager};
                let app_for_listener = app.handle().clone();
                let kernel = kernel_arc_for_listener.clone();
                let pa_db_for_listener = pa_db.clone();
                let debounce_token: Arc<std::sync::atomic::AtomicU64> =
                    Arc::new(std::sync::atomic::AtomicU64::new(0));
                app_for_listener.clone().listen("projects:active-changed", move |evt| {
                    // Pull `id` out of the payload.
                    let active = serde_json::from_str::<serde_json::Value>(evt.payload())
                        .ok()
                        .and_then(|v| v.get("id").and_then(|s| s.as_str().map(String::from)));
                    let Some(active) = active else { return };
                    let token =
                        debounce_token.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
                    let kernel = kernel.clone();
                    let token_check = debounce_token.clone();
                    let _pa_db = pa_db_for_listener.clone();
                    tauri::async_runtime::spawn(async move {
                        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                        // If another active-changed landed during the sleep,
                        // a later iteration will win — drop this one.
                        if token_check.load(std::sync::atomic::Ordering::Relaxed) != token {
                            return;
                        }
                        if let Err(e) = kernel.reconcile_for_project(&active) {
                            log::warn!(
                                "[pkg_kernel] reconcile for active=`{active}` failed: {e:#}"
                            );
                        }
                    });
                });
            }

            // Phase 7 (projects-first-class): re-dump the runtime env-vault
            // file on every project switch so sidecars and per-call MCP
            // children see the active project's resolved secrets cascade
            // on next spawn. The dump itself is sync + Stronghold-locked,
            // so we hop it onto a background thread to keep the Tauri
            // event-loop responsive (same reasoning as the boot-time dump
            // below).
            {
                use tauri::Listener;
                let app_for_secrets = app.handle().clone();
                app_for_secrets
                    .clone()
                    .listen("projects:active-changed", move |_evt| {
                        let app_for_dump = app_for_secrets.clone();
                        std::thread::spawn(move || {
                            match commands::secrets::dump_to_runtime_file(&app_for_dump) {
                                Ok(path) => log::info!(
                                    "env-vault re-dumped after project switch -> {}",
                                    path.display()
                                ),
                                Err(e) => log::warn!(
                                    "env-vault re-dump after project switch skipped: {e}"
                                ),
                            }
                        });
                    });
            }

            // Phase 0.5 background-execution spike state. Debug builds only.
            // See commands/bg_spike.rs.
            #[cfg(debug_assertions)]
            app.manage(new_bg_spike_state());

            // Phase 14: write the runtime env-vault file so the actions
            // sidecar can read vault values via its existing dotenv loader.
            // Best-effort: a failure here just means sidecars fall through
            // to ~/.config/pa-actions/env or ikenga/.env.
            //
            // FE-init-fix (2026-05-13): this used to run synchronously
            // here, but Stronghold::new + get_client can block the setup
            // thread indefinitely on Linux when the snapshot file is in
            // a degraded state — which stalls the GTK event loop and
            // prevents the main window from ever being presented. We
            // hop it onto a background OS thread so setup returns
            // immediately. The actions sidecar only reads the env-vault
            // file when it spawns, which is well after boot.
            let app_for_dump = app.handle().clone();
            std::thread::spawn(move || {
                match commands::secrets::dump_to_runtime_file(&app_for_dump) {
                    Ok(path) => log::info!("env-vault dumped to {}", path.display()),
                    Err(e) => log::warn!("env-vault dump skipped: {e}"),
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // pty
            pty_spawn,
            pty_write,
            pty_resize,
            pty_kill,
            pty_foreground,
            pty_foreground_snapshot,
            // fs
            fs_read,
            fs_write,
            fs_mkdir,
            fs_exists,
            fs_kind,
            fs_list,
            fs_mime,
            fs_watch,
            fs_unwatch,
            fs_trash,
            fs_rename,
            fs_search,
            // fs allowlist (user-configurable roots)
            fs_roots_list,
            fs_roots_add,
            fs_roots_remove,
            fs_roots_reset,
            // claude
            claude_list_sessions,
            claude_read_jsonl,
            // chat sessions (thread_id-keyed)
            chat_threads_list_by_project,
            chat_thread_move,
            session_ensure,
            session_send,
            session_tool_result,
            session_cancel,
            session_destroy,
            session_destroy_all,
            // acp (phase 3 — runs alongside legacy session_* until phase 10)
            chat_initialize,
            chat_new_session,
            chat_prompt,
            chat_cancel,
            // acp permission round-trip (phase 4)
            chat_respond_permission,
            // acp session modes (phase 5)
            chat_set_mode,
            // adr-011 phase 3: session-level model + effort (per-turn deferred)
            chat_set_model,
            chat_set_effort,
            // acp session fork + faster resume (phase 8)
            chat_fork_session,
            chat_load_session,
            // claude config browser
            claude_config_load,
            claude_config_watch,
            claude_config_unwatch,
            claude_config_read_file,
            // claude config — Phase 4 (4-tier discovery + pin CRUD)
            claude_assets_discover,
            claude_asset_pin,
            claude_asset_unpin,
            claude_asset_list_pins,
            // viewer
            viewer_serve,
            viewer_stop,
            viewer_port,
            // secrets
            secrets_get,
            secrets_set,
            secrets_delete,
            secrets_list_keys,
            secrets_vault_status,
            // secrets — Phase 7 scoped variants
            secrets_get_scoped,
            secrets_set_scoped,
            secrets_delete_scoped,
            secrets_list_keys_scoped,
            // settings_kv (durable mirror for Zustand-backed prefs)
            settings_get,
            settings_set,
            settings_get_all,
            settings_clear_all,
            // projects (phase 0 of projects-first-class plan)
            project_create,
            project_update,
            project_list,
            project_archive,
            project_set_active,
            project_get_active,
            project_inventory,
            project_skills_list,
            project_scaffold_claude,
            project_artifacts_walk,
            // supabase config (URL + anon key manifest)
            supabase_config_get,
            supabase_config_set,
            supabase_config_clear,
            // trust gating (Phase 9)
            pkg_trust_list,
            pkg_trust_preview,
            pkg_trust_grant,
            pkg_trust_revoke,
            // trust-review modal (2026-05-15) — capability-diff batch surface
            pkg_trust_list_pending,
            pkg_trust_approve,
            pkg_trust_reject,
            // runtime-ACL violations audit (2026-05-15)
            pkg_permission_violations_list,
            pkg_permission_violations_clear,
            // db
            db_query,
            db_exec,
            // iyke
            iyke_endpoint,
            iyke_set_shell,
            iyke_log_push,
            iyke_network_push,
            iyke_dom_done,
            iyke_dom_query,
            iyke_query_cache_done,
            iyke_wait_done,
            iyke_terminal_read_done,
            iyke::browser_handlers::iyke_browser_reply,
            // backup / restore
            backup_export,
            backup_import,
            backup_list,
            backup_delete,
            // desktop
            set_dock_badge,
            iyke_mcp_info,
            // screenshots
            screenshot_window,
            screenshot_pane,
            screenshot_capture_done,
            screenshot_capture_failed,
            screenshot_get_config,
            screenshot_set_dir,
            // spike: dynamic ACL verification (delete after kernel lands)
            spike_grant_fs_read,
            spike_setup_test_file,
            // pkg-browser child webviews
            pkg_webview_create,
            pkg_webview_destroy,
            pkg_webview_navigate,
            pkg_webview_set_rect,
            // Phase 0.5 bg-execution spike. Debug builds only.
            #[cfg(debug_assertions)]
            bg_spike_run,
            #[cfg(debug_assertions)]
            bg_spike_reply,
            // pkg kernel
            pkg_install_from_path,
            pkg_install_from_registry,
            pkg_uninstall,
            pkg_set_enabled,
            pkg_set_scope,
            pkg_kernel_status,
            pkg_discover_workspace,
            pkg_db_diag,
            pkg_settings_get,
            pkg_settings_set,
            pkg_preview_manifest,
            pkg_screenshot,
            pkg_content_url,
            pkg_content_html,
            pkg_content_revoke,
            pkg_mcp_call,
            pkg_sidecar_call,
            pkg_supervisor_restart,
            dev_bind_port,
            dev_release_port,
            // first-run wizard detection
            agent_detect::detect_system,
            agent_detect::detect_agents,
            agent_detect::detect_agent,
            agent_detect::detect_agent_config,
            agent_detect::list_claude_projects,
            agent_detect::scaffold_agent_config,
            // activity bar pinning
            activity_pins_list,
            activity_pins_add,
            activity_pins_remove,
            activity_pins_reorder,
            activity_pins_resolve_artifact,
            activity_pins_touch_open,
            activity_sections_list,
            activity_sections_create,
            activity_sections_update,
            activity_sections_remove,
            // artifact-grid pin comments
            comment_create,
            comment_get,
            comment_list,
            comment_record_routing,
            comment_set_status,
            comment_delete,
            comment_route,
            pin_screenshot_write,
            // artifact-studio chat threads (one per folder, D3)
            studio_thread_get_or_create,
            studio_thread_get,
            studio_thread_list_recent,
            studio_thread_delete,
            studio_message_append,
            studio_message_list,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            // Phase 14: best-effort cleanup of the runtime env-vault file
            // when the app is shutting down. Not critical (the file lives
            // in $XDG_RUNTIME_DIR / $TMPDIR, both per-user-volatile), but
            // keeps the surface tidy.
            if let tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit = event {
                commands::secrets::cleanup_runtime_file();
            }
        });
}

/// Set up tracing → stderr + a rolling file in the platform log dir. Best
/// effort; if the dir is unavailable we just log to stderr.
fn init_logging() {
    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;
    use tracing_subscriber::EnvFilter;

    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));

    let log_dir = log_dir();
    let stderr_layer = tracing_subscriber::fmt::layer().with_writer(std::io::stderr);

    if let Some(dir) = log_dir {
        let _ = std::fs::create_dir_all(&dir);
        let appender = tracing_appender::rolling::daily(&dir, "ikenga.log");
        let file_layer = tracing_subscriber::fmt::layer()
            .with_ansi(false)
            .with_writer(appender);
        tracing_subscriber::registry()
            .with(filter)
            .with(stderr_layer)
            .with(file_layer)
            .init();
    } else {
        tracing_subscriber::registry()
            .with(filter)
            .with(stderr_layer)
            .init();
    }
}

/// Build the global-shortcut plugin. The handler dispatches by shortcut:
/// the summon binding toggles window visibility, the screenshot bindings
/// emit `screenshot://shortcut` events that the FE picks up and routes
/// back through `screenshot_window` / `screenshot_pane`. Doing the
/// focused-pane resolution in the FE avoids mirroring `usePaneStore` on
/// the Rust side just for one handler.
fn global_shortcut_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    use tauri_plugin_global_shortcut::{Builder, Code, Modifiers, Shortcut, ShortcutState};

    let summon = if cfg!(target_os = "macos") {
        Shortcut::new(Some(Modifiers::ALT), Code::Space)
    } else {
        Shortcut::new(Some(Modifiers::SUPER), Code::Space)
    };
    let shot_window = Shortcut::new(
        Some(Modifiers::CONTROL | Modifiers::ALT | Modifiers::SHIFT),
        Code::KeyS,
    );
    let shot_pane = Shortcut::new(
        Some(Modifiers::CONTROL | Modifiers::ALT | Modifiers::SHIFT),
        Code::KeyP,
    );

    Builder::new()
        .with_handler(move |app, shortcut, event| {
            if event.state() != ShortcutState::Pressed {
                return;
            }
            if shortcut == &summon {
                if let Some(window) = app.get_webview_window("main") {
                    let visible = window.is_visible().unwrap_or(false);
                    if visible && window.is_focused().unwrap_or(false) {
                        let _ = window.hide();
                    } else {
                        let _ = window.unminimize();
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            } else if shortcut == &shot_window {
                let _ = app.emit(
                    "screenshot://shortcut",
                    serde_json::json!({ "kind": "window" }),
                );
            } else if shortcut == &shot_pane {
                let _ = app.emit(
                    "screenshot://shortcut",
                    serde_json::json!({ "kind": "pane-focused" }),
                );
            }
        })
        .build()
}

/// ⌥Space on Mac, Super+Space on Linux. Toggle main window visibility.
fn register_summon_shortcut(
    app: &tauri::AppHandle,
) -> Result<(), tauri_plugin_global_shortcut::Error> {
    use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};

    let modifiers = if cfg!(target_os = "macos") {
        Modifiers::ALT
    } else {
        Modifiers::SUPER
    };
    let shortcut = Shortcut::new(Some(modifiers), Code::Space);
    app.global_shortcut().register(shortcut)?;
    Ok(())
}

/// Ctrl+Alt+Shift+S = window screenshot, Ctrl+Alt+Shift+P = focused-pane
/// screenshot. The plugin handler dispatches to the correct branch by
/// matching the `Shortcut` value. Tolerant: each binding is registered
/// individually so a clash on one doesn't kill the other.
fn register_screenshot_shortcuts(app: &tauri::AppHandle) {
    use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};

    let mods = Modifiers::CONTROL | Modifiers::ALT | Modifiers::SHIFT;
    for (sc, label) in [
        (Shortcut::new(Some(mods), Code::KeyS), "screenshot:window"),
        (Shortcut::new(Some(mods), Code::KeyP), "screenshot:pane"),
    ] {
        if let Err(e) = app.global_shortcut().register(sc) {
            log::warn!("{label} shortcut not registered (continuing): {e}");
        }
    }
}

// ─── CLI screenshot dispatch ──────────────────────────────────────────────────
//
// `ikenga-desktop --screenshot=window` / `--screenshot=pane:<id>` is
// intercepted at the very top of `run()`. We never start a Tauri instance
// for a CLI invocation — instead we read the running app's `control.json`,
// POST to its iyke server, print the result, and exit. If the app isn't
// running there's no daemon mode to fall through to: print an error and
// exit 1.

#[derive(Debug, Clone, PartialEq, Eq)]
enum ScreenshotCli {
    Window,
    Pane(String),
}

fn parse_screenshot_arg<I: Iterator<Item = String>>(args: I) -> Option<ScreenshotCli> {
    for a in args.skip(1) {
        if let Some(rest) = a.strip_prefix("--screenshot=") {
            return parse_screenshot_value(rest);
        }
    }
    None
}

fn parse_screenshot_value(v: &str) -> Option<ScreenshotCli> {
    if v == "window" {
        Some(ScreenshotCli::Window)
    } else if let Some(id) = v.strip_prefix("pane:") {
        if id.is_empty() {
            None
        } else {
            Some(ScreenshotCli::Pane(id.to_string()))
        }
    } else {
        None
    }
}

#[derive(serde::Deserialize)]
struct ControlFileRead {
    port: u16,
    token: String,
}

fn screenshot_cli_control_path() -> Option<std::path::PathBuf> {
    // Identifier must match `tauri.conf.json:identifier` so the running
    // shell and the --screenshot CLI path agree on where control.json
    // lives. Pre-strip this hardcoded `io.royalti.pa.desktop`, which had
    // drifted from the real bundle id `app.ikenga` and broke the CLI on
    // any clean install.
    let home = std::env::var_os("HOME").map(std::path::PathBuf::from)?;
    #[cfg(target_os = "macos")]
    {
        Some(home.join("Library/Application Support/app.ikenga/control.json"))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Some(home.join(".local/share/app.ikenga/control.json"))
    }
    #[cfg(target_os = "windows")]
    {
        let _ = home;
        std::env::var_os("LOCALAPPDATA")
            .map(std::path::PathBuf::from)
            .map(|p| p.join("app.ikenga").join("control.json"))
    }
}

fn run_screenshot_cli(cmd: ScreenshotCli) -> i32 {
    let Some(control_path) = screenshot_cli_control_path() else {
        eprintln!("error: could not resolve control.json path");
        return 1;
    };
    if !control_path.exists() {
        eprintln!(
            "error: app not running ({} not found)",
            control_path.display()
        );
        return 1;
    }
    let json = match std::fs::read(&control_path) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("error: read {}: {e}", control_path.display());
            return 1;
        }
    };
    let cf: ControlFileRead = match serde_json::from_slice(&json) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("error: parse control.json: {e}");
            return 1;
        }
    };

    let (path, body) = match &cmd {
        ScreenshotCli::Window => ("/iyke/screenshot/window", serde_json::json!({})),
        ScreenshotCli::Pane(id) => (
            "/iyke/screenshot/pane",
            serde_json::json!({ "pane_id": id }),
        ),
    };
    let url = format!("http://127.0.0.1:{}{}", cf.port, path);

    // ureq is blocking — fine here because we run before the Tokio runtime
    // exists and exit immediately after.
    let req = ureq::post(&url)
        .set("Authorization", &format!("Bearer {}", cf.token))
        .set("Content-Type", "application/json")
        .timeout(std::time::Duration::from_secs(15));
    match req.send_json(body) {
        Ok(resp) => {
            let body = resp.into_string().unwrap_or_default();
            println!("{body}");
            0
        }
        Err(ureq::Error::Status(code, resp)) => {
            let body = resp.into_string().unwrap_or_default();
            eprintln!("error: {code} {body}");
            1
        }
        Err(e) => {
            eprintln!("error: {e}");
            1
        }
    }
}

#[cfg(test)]
mod cli_tests {
    use super::*;

    #[test]
    fn parses_window() {
        let args = ["ikenga-desktop", "--screenshot=window"]
            .into_iter()
            .map(String::from);
        assert_eq!(parse_screenshot_arg(args), Some(ScreenshotCli::Window));
    }

    #[test]
    fn parses_pane() {
        let args = ["ikenga-desktop", "--screenshot=pane:abc-123"]
            .into_iter()
            .map(String::from);
        assert_eq!(
            parse_screenshot_arg(args),
            Some(ScreenshotCli::Pane("abc-123".into()))
        );
    }

    #[test]
    fn rejects_empty_pane_id() {
        assert_eq!(parse_screenshot_value("pane:"), None);
    }

    #[test]
    fn ignores_other_args() {
        let args = ["bin", "--other", "value"].into_iter().map(String::from);
        assert_eq!(parse_screenshot_arg(args), None);
    }
}

fn log_dir() -> Option<std::path::PathBuf> {
    let home = std::env::var_os("HOME")?;
    let home = std::path::PathBuf::from(home);
    #[cfg(target_os = "macos")]
    {
        Some(home.join("Library/Logs/Ikenga"))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Some(home.join(".local/share/ikenga/logs"))
    }
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("LOCALAPPDATA")
            .map(std::path::PathBuf::from)
            .map(|p| p.join("Ikenga").join("logs"))
    }
}
