pub mod claude;
mod commands;
mod fs_watch;
mod iyke;
mod pkg;
mod pkg_content;
mod pty;
mod render;
mod sidecar;
pub mod vault_key;
mod viewer_server;

use std::sync::Arc;

use tauri::{Emitter, Manager};
use tauri_plugin_sql::{Migration, MigrationKind};
use tokio::sync::Mutex;

use commands::db::PaDb;
use commands::screenshot::new_pending as new_screenshot_pending;
use commands::{
    chat_cancel, chat_send, claude_chat_kill, claude_chat_send, claude_chat_spawn,
    claude_config_load, claude_config_read_file, claude_config_unwatch, claude_config_watch,
    pa_actions_run,
    claude_list_sessions, claude_read_jsonl, claude_spawn_session, db_exec, db_query, fs_exists,
    fs_list, fs_mime, fs_read, fs_rename, fs_trash,
    fs_unwatch, fs_watch, fs_write, iyke_dom_done, iyke_endpoint,
    iyke_log_push, iyke_network_push, iyke_query_cache_done, iyke_set_shell, iyke_wait_done,
    mbox_ping, mbox_read_all, pty_kill,
    pty_resize, pty_spawn,
    pty_write, render_cancel, render_composition, screenshot_capture_done,
    screenshot_capture_failed, screenshot_get_config, screenshot_pane, screenshot_set_dir,
    screenshot_window, secrets_delete, secrets_get, secrets_import_dotenv, secrets_list_keys,
    pkg_content_html, pkg_content_revoke, pkg_content_url, pkg_db_diag, pkg_discover_workspace,
    pkg_install_from_path, pkg_kernel_status,
    pkg_mcp_call, pkg_preview_manifest, pkg_settings_get, pkg_settings_set, pkg_supervisor_restart,
    pkg_uninstall, dev_bind_port, dev_release_port,
    secrets_set, secrets_vault_status, PkgContentState, SidecarSupervisorState,
    set_dock_badge, spike_grant_fs_read, spike_setup_test_file, KernelState, PkgSettingsState,
    SecretsLock,
    storyboard_export_json, storyboard_import_json, storyboard_list_concepts,
    storyboard_promote_rung, storyboard_render_still,
    viewer_serve, viewer_stop, ClaudeManager, ClaudeManagerState, IykeRuntimeState,
    JobManagerState, ScreenshotConfigState, ScreenshotConfigStateRef, ScreenshotPending,
    StoryboardJobManager, StoryboardJobManagerState,
};
use render::JobManager;
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

    let pty_manager = Arc::new(PtyManager::new());
    let fs_watch_manager = Arc::new(FsWatchManager::new());
    let viewer_manager = Arc::new(ViewerServerManager::new());
    let claude_manager: ClaudeManagerState = Arc::new(ClaudeManager::new());
    let render_manager: JobManagerState = Arc::new(JobManager::new());
    let storyboard_jobs: StoryboardJobManagerState = Arc::new(StoryboardJobManager::new());
    let screenshot_pending: ScreenshotPending = new_screenshot_pending();

    let migrations = vec![
        Migration {
            version: 1,
            description: "init",
            sql: include_str!("../migrations/0001_init.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "viewer_recents",
            sql: include_str!("../migrations/0002_viewer_recents.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "claude_sessions",
            sql: include_str!("../migrations/0003_claude_sessions.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "render_queue",
            sql: include_str!("../migrations/0004_render_queue.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 5,
            description: "mbox_sync",
            sql: include_str!("../migrations/0005_mbox_sync.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 6,
            description: "storyboards",
            sql: include_str!("../migrations/0006_storyboards.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 7,
            description: "pkg_kernel",
            sql: include_str!("../migrations/0007_pkg_kernel.sql"),
            kind: MigrationKind::Up,
        },
    ];

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(global_shortcut_plugin())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:pa.db", migrations)
                .build(),
        )
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
        .manage(claude_manager)
        .manage(render_manager)
        .manage(storyboard_jobs)
        .manage(screenshot_pending.clone())
        .manage(SecretsLock::new())
        .setup(move |app| {
            // Ensure app data dir exists; SQLite + Stronghold both write here.
            let data_dir = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("app_data_dir: {e}"))?;
            std::fs::create_dir_all(&data_dir)?;

            // Db wrapper points at the same file the plugin manages.
            let db_path = data_dir.join("pa.db");
            let pa_db = Arc::new(PaDb::new(db_path));
            app.manage(pa_db.clone());

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

            #[cfg(target_os = "macos")]
            apply_mac_vibrancy(app.handle());

            // Iyke (Phase 11): localhost control bridge. Boot synchronously so
            // the server is ready by the time the webview asks for its
            // endpoint via `iyke_endpoint`. block_on is safe here — setup
            // runs outside any tokio runtime.
            let iyke_state = Arc::new(IykeState::new());
            let iyke_rpc = IykeRpc::new();
            let local_data_dir = app
                .path()
                .app_local_data_dir()
                .map_err(|e| format!("app_local_data_dir: {e}"))?;
            let control_path = local_data_dir.join("control.json");

            // Build the iyke routes registry *before* iyke::start so the
            // axum router gets a handle to it. Same Arc passes to the
            // kernel further down — register/unregister mutate it live.
            let iyke_routes_reg = Arc::new(pkg::registries::IykeRoutesRegistry::new());

            let iyke_state_for_start = iyke_state.clone();
            let iyke_rpc_for_start = iyke_rpc.clone();
            let app_handle_for_iyke = app.handle().clone();
            let pending_for_iyke = screenshot_pending.clone();
            let iyke_routes_for_start = iyke_routes_reg.clone();
            let runtime = tauri::async_runtime::block_on(async move {
                iyke::start(
                    iyke_state_for_start,
                    iyke_rpc_for_start,
                    control_path,
                    app_handle_for_iyke,
                    pending_for_iyke,
                    iyke_routes_for_start,
                )
                .await
            })
            .map_err(|e| format!("iyke start: {e:#}"))?;

            app.manage(iyke_state);
            app.manage(iyke_rpc);
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
            let cron_reg = Arc::new(pkg::registries::CronRegistry::new(app.handle().clone()));
            let ui_routes_reg = Arc::new(pkg::registries::UiRoutesRegistry::new());
            let claude_assets_reg = Arc::new(pkg::registries::ClaudeAssetsRegistry::new());
            let mcp_reg = Arc::new(pkg::registries::McpRegistry::new());
            let queries_reg = Arc::new(pkg::registries::QueriesRegistry::new());
            // Sidecar supervisor: itself a Registry, owns long-lived MCP
            // children for any pkg with `mcp[].lifecycle = "long-lived"`.
            // Held separately as an Arc so `pkg_mcp_call` can dispatch to it
            // without going through the kernel snapshot.
            let sidecar_supervisor =
                Arc::new(pkg::SidecarSupervisor::with_app(app.handle().clone()));
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
            let kernel = Arc::new(pkg::Kernel::new(
                app.handle().clone(),
                pa_db.clone(),
                vec![
                    sidecars_reg as Arc<dyn pkg::Registry>,
                    perms_reg as Arc<dyn pkg::Registry>,
                    iyke_routes_reg as Arc<dyn pkg::Registry>,
                    settings_reg.clone() as Arc<dyn pkg::Registry>,
                    cron_reg as Arc<dyn pkg::Registry>,
                    ui_routes_reg as Arc<dyn pkg::Registry>,
                    claude_assets_reg as Arc<dyn pkg::Registry>,
                    mcp_reg as Arc<dyn pkg::Registry>,
                    queries_reg as Arc<dyn pkg::Registry>,
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
            app.manage(KernelState(kernel));
            app.manage(PkgSettingsState(settings_reg));
            app.manage(PkgContentState(pkg_content_server));
            app.manage(SidecarSupervisorState(sidecar_supervisor));

            // Phase 14: write the runtime env-vault file so the actions
            // sidecar can read vault values via its existing dotenv loader.
            // Best-effort: a failure here just means sidecars fall through
            // to ~/.config/pa-actions/env or ikenga/.env.
            match commands::secrets::dump_to_runtime_file(&app.handle().clone()) {
                Ok(path) => log::info!("env-vault dumped to {}", path.display()),
                Err(e) => log::warn!("env-vault dump skipped: {e}"),
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // pty
            pty_spawn,
            pty_write,
            pty_resize,
            pty_kill,
            // fs
            fs_read,
            fs_write,
            fs_exists,
            fs_list,
            fs_mime,
            fs_watch,
            fs_unwatch,
            fs_trash,
            fs_rename,
            // claude
            claude_spawn_session,
            claude_list_sessions,
            claude_chat_spawn,
            claude_chat_send,
            claude_chat_kill,
            claude_read_jsonl,
            // claude config browser
            claude_config_load,
            claude_config_watch,
            claude_config_unwatch,
            claude_config_read_file,
            // viewer
            viewer_serve,
            viewer_stop,
            // secrets
            secrets_get,
            secrets_set,
            secrets_delete,
            secrets_list_keys,
            secrets_vault_status,
            secrets_import_dotenv,
            // db
            db_query,
            db_exec,
            // chat (stubs)
            chat_send,
            chat_cancel,
            // render (stubs)
            render_composition,
            render_cancel,
            // iyke
            iyke_endpoint,
            iyke_set_shell,
            iyke_log_push,
            iyke_network_push,
            iyke_dom_done,
            iyke_query_cache_done,
            iyke_wait_done,
            // mbox sidecar
            mbox_read_all,
            mbox_ping,
            // pa-actions sidecar (mutations + pollers, replaces ikenga)
            pa_actions_run,
            // storyboard (phase 7)
            storyboard_render_still,
            storyboard_promote_rung,
            storyboard_list_concepts,
            storyboard_export_json,
            storyboard_import_json,
            // desktop
            set_dock_badge,
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
            // pkg kernel
            pkg_install_from_path,
            pkg_uninstall,
            pkg_kernel_status,
            pkg_discover_workspace,
            pkg_db_diag,
            pkg_settings_get,
            pkg_settings_set,
            pkg_preview_manifest,
            pkg_content_url,
            pkg_content_html,
            pkg_content_revoke,
            pkg_mcp_call,
            pkg_supervisor_restart,
            dev_bind_port,
            dev_release_port,
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
                let _ = app.emit("screenshot://shortcut", serde_json::json!({ "kind": "window" }));
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

#[cfg(target_os = "macos")]
fn apply_mac_vibrancy(app: &tauri::AppHandle) {
    use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};
    if let Some(window) = app.get_webview_window("main") {
        // HudWindow blends well with our dark theme; failure is non-fatal.
        let _ = apply_vibrancy(
            &window,
            NSVisualEffectMaterial::HudWindow,
            Some(NSVisualEffectState::Active),
            None,
        );
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
    let home = std::env::var_os("HOME").map(std::path::PathBuf::from)?;
    #[cfg(target_os = "macos")]
    {
        Some(home.join("Library/Application Support/io.royalti.pa.desktop/control.json"))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Some(home.join(".local/share/io.royalti.pa.desktop/control.json"))
    }
    #[cfg(target_os = "windows")]
    {
        let _ = home;
        std::env::var_os("LOCALAPPDATA")
            .map(std::path::PathBuf::from)
            .map(|p| p.join("io.royalti.pa.desktop").join("control.json"))
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
