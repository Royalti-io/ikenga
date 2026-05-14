//! Package manifest types.
//!
//! A manifest is the on-disk contract between a package and the host kernel.
//! Every block is optional — a "skill pack" might only declare `skills`, an
//! embedded app declares `sidecars` + `ui`, a windowed app adds `window`.
//! The kernel walks the present blocks and registers each against the
//! corresponding registry; absent blocks are no-ops.
//!
//! Versioning policy: the host supports `ikenga_api` versions {N, N-1}. Older
//! manifests are auto-disabled with a user-facing message rather than shimmed
//! — see `IKENGA_API_VERSION` and `is_compatible`.
//!
//! Names use snake_case in JSON (matching the spec discussed) and are
//! re-mapped via `#[serde(rename = "...")]` where Rust idiom differs.
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};

/// Current host API contract version. Bump when manifest semantics change in
/// a non-additive way. Packages declaring older versions are auto-disabled
/// once they fall outside the {current, current-1} support window.
pub const IKENGA_API_VERSION: u32 = 1;

/// Smallest supported manifest version. Packages with older `ikenga_api` are
/// auto-disabled at boot; the kernel surfaces them with an "update required"
/// state for the user.
pub const IKENGA_API_MIN_SUPPORTED: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub ikenga_api: String,

    #[serde(default)]
    pub kind: Option<String>, // "skill" | "embedded" | "windowed" — hint, not enforced

    #[serde(default)]
    pub author: Option<Author>,

    #[serde(default)]
    pub targets: Vec<String>, // rust target triples, empty = host-agnostic (skill packs)

    // ── Capability blocks (all optional) ────────────────────────────────────
    /// Path inside the package dir to a folder of Claude Code skills.
    /// Installer copies to `~/.claude/skills/<pkg>/`.
    #[serde(default)]
    pub skills: Option<String>,

    /// Path to a folder of slash-command markdown files. Copied to
    /// `~/.claude/commands/<pkg>/`.
    #[serde(default)]
    pub commands: Option<String>,

    /// Path to a folder of agent definitions. Copied to `~/.claude/agents/<pkg>/`.
    #[serde(default)]
    pub agents: Option<String>,

    /// MCP servers contributed by this package.
    #[serde(default)]
    pub mcp: Vec<McpServer>,

    /// Sidecar binaries this package ships.
    #[serde(default)]
    pub sidecars: Vec<SidecarSpec>,

    /// Permissions the package needs. Mapped to Tauri capability scopes by
    /// the permission registry.
    #[serde(default)]
    pub permissions: Permissions,

    /// Path to package-namespaced SQL migrations directory. Files named
    /// `<n>_<name>.sql` are applied in order, recorded in `pkg_migrations`.
    #[serde(default)]
    pub migrations: Option<String>,

    /// Inline declarative settings schema. Each field has a key/type/default/
    /// label; values live in `pkg_settings` keyed by `(pkg_id, key)`.
    #[serde(default)]
    pub settings: Option<SettingsBlock>,

    #[serde(default)]
    pub ui: Option<UiBlock>,

    /// New iyke RPC routes / events owned by this package.
    #[serde(default)]
    pub iyke: Option<IykeBlock>,

    /// Cron entries — registered with the existing cron infra, namespaced.
    #[serde(default)]
    pub cron: Vec<CronEntry>,

    /// Window block for "windowed" packages that want their own Tauri window.
    #[serde(default)]
    pub window: Option<WindowBlock>,

    /// TanStack Query key prefixes this package claims (collision check).
    #[serde(default)]
    pub queries: Option<QueriesBlock>,

    /// Optional capabilities the host should resolve and inject at iframe-mount
    /// time (e.g. shared Supabase URL + anon key from the Stronghold vault).
    /// Pkgs declare what they need; the shell resolves and threads it via the
    /// AppBridge `hostContext` handshake. Pkgs that don't declare a capability
    /// never see the corresponding values.
    #[serde(default)]
    pub capabilities: Option<CapabilitiesBlock>,

    /// Engine-adapter manifest block. Present iff this pkg is an engine-*
    /// adapter. Declares the agent id, display name, capability snapshot,
    /// and onboarding hints surfaced by the first-run wizard. Mirrors
    /// `EngineProvidesSchema` in `@ikenga/contract/engine`.
    #[serde(default)]
    pub engine: Option<EngineBlock>,
}

// ---- Engine adapter manifest block (mirrors @ikenga/contract engine.ts) -----

/// Capability snapshot every engine adapter advertises. The fields are a
/// *superset* of what any single adapter supports — adapters set
/// implemented flags to `true` and the rest to `false`. New fields here
/// must be added to `AgentCapabilitiesSchema` in @ikenga/contract in
/// lockstep.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentCapabilities {
    pub streaming: bool,
    #[serde(rename = "toolUse")]
    pub tool_use: bool,
    pub thinking: bool,
    pub artifacts: bool,
    #[serde(rename = "fileAttachments")]
    pub file_attachments: bool,
    #[serde(rename = "imageInput")]
    pub image_input: bool,
    #[serde(rename = "slashCommands")]
    pub slash_commands: bool,
    #[serde(rename = "modelSwitching")]
    pub model_switching: bool,
    #[serde(rename = "promptCaching")]
    pub prompt_caching: bool,
    #[serde(rename = "agenticTools")]
    pub agentic_tools: bool,
    pub mcp: bool,
    #[serde(rename = "sessionResume")]
    pub session_resume: bool,
}

/// Per-adapter onboarding requirements surfaced by the wizard.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EngineOnboarding {
    #[serde(default, rename = "requiredVaultKeys")]
    pub required_vault_keys: Vec<String>,
    #[serde(default, rename = "requiredEnvVars")]
    pub required_env_vars: Vec<String>,
    /// CLI command the user can run to authenticate. The wizard surfaces
    /// this as a copy-to-clipboard hint — it never shells out on behalf
    /// of the user.
    #[serde(default, rename = "authCommand")]
    pub auth_command: Option<String>,
    /// Docs URL for setting up this adapter.
    #[serde(default, rename = "docsUrl")]
    pub docs_url: Option<String>,
}

/// Manifest block declared by engine-* pkgs.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EngineBlock {
    /// Stable id — matches the detection-side agent id.
    #[serde(rename = "agentId")]
    pub agent_id: String,
    /// Display name; overrides any detection-side display if both present.
    #[serde(default)]
    pub display: Option<String>,
    /// Snapshot of what this adapter implements.
    pub capabilities: AgentCapabilities,
    /// Onboarding requirements composed by the wizard.
    #[serde(default)]
    pub onboarding: EngineOnboarding,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CapabilitiesBlock {
    #[serde(default)]
    pub supabase: Option<SupabaseCapability>,
    /// Native child-webview capability. Required for any `ui.routes[]` entry
    /// with `kind = "webview"` to mount. See `pkg/webview.rs` for the kernel
    /// implementation. Mirrors `WebviewCapabilitySchema` in
    /// `@ikenga/contract/manifest.ts`.
    #[serde(default)]
    pub webview: Option<WebviewCapability>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SupabaseCapability {
    /// When true, mint fails if `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`
    /// are missing from the vault. When false (or omitted), missing keys are
    /// surfaced as `supabase: null` in the host context and the pkg may fall
    /// back to its own dev `.env.local`.
    #[serde(default)]
    pub required: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct WebviewCapability {
    /// Whether this pkg requests the right to create child webviews via the
    /// kernel. Required for any `ui.routes[]` entry with `kind = "webview"`
    /// to mount. Defaults to false; the kernel rejects mount with an explicit
    /// error if the route declares `webview` but the capability is missing.
    #[serde(default)]
    pub child_webviews: bool,
    /// Named cookie/data partitions the pkg may use. Created lazily on first
    /// navigate per name; uninstall drops them all. Empty = pkg uses the
    /// implicit "default" partition.
    #[serde(default)]
    pub partitions: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Author {
    pub name: String,
    #[serde(default)]
    pub key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServer {
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    /// Process model for this MCP server. `"per-call"` (default) spawns a
    /// fresh stdio child per `tools/call` and reaps it on completion — fine
    /// for stateless tools and the synthetic test fixtures. `"long-lived"`
    /// asks the kernel's `SidecarSupervisor` to boot the child once on
    /// install/boot, keep it alive across calls, multiplex requests over
    /// stdin/stdout, and restart on crash. Required for sidecars that own
    /// session state (preview servers, watchers, render workers).
    #[serde(default)]
    pub lifecycle: Option<String>,

    /// Phase 9: glob patterns relative to the package dir. The supervisor
    /// restarts the long-lived child when any matched file changes (250 ms
    /// debounce). Empty = no watcher. Per-call entries ignore this.
    #[serde(default)]
    pub restart_when_changed: Vec<String>,

    /// Phase 9: auto-restart on unexpected exit. Defaults to true (existing
    /// supervisor behavior). Set false for one-shot tools that should run
    /// once and transition to Stopped instead of looping. Per-call entries
    /// ignore this — they're already one-shot by definition.
    #[serde(default = "default_auto_restart")]
    pub auto_restart: bool,
}

impl McpServer {
    /// True when the manifest opts this server into the supervised long-lived
    /// path. Anything other than the literal string `"long-lived"` (including
    /// `None`, `""`, and unknown values) means per-call.
    pub fn is_long_lived(&self) -> bool {
        matches!(self.lifecycle.as_deref(), Some("long-lived"))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SidecarSpec {
    /// Sidecar name. Enforced format: `pa-{pkg-id-slug}-{sub}` to avoid
    /// collisions in Tauri's per-name shell scope.
    pub name: String,
    /// Path inside the package dir to the binary. May contain `{target}`
    /// which the loader expands to the host's target triple.
    pub bin: String,
    /// Communication mode the sidecar speaks on stdio.
    #[serde(default = "default_stdio")]
    pub stdio: String, // "json" | "raw"

    /// Phase 9: glob patterns relative to the package dir. The supervisor
    /// restarts the sidecar when any matched file changes (250 ms debounce).
    /// Empty = no watcher.
    #[serde(default)]
    pub restart_when_changed: Vec<String>,

    /// Phase 9: auto-restart on unexpected exit. Defaults to true (existing
    /// behavior). Set false for one-shot tools that should run once and
    /// transition to Stopped instead of looping through the strike budget.
    #[serde(default = "default_auto_restart")]
    pub auto_restart: bool,
}

fn default_stdio() -> String {
    "json".into()
}

fn default_auto_restart() -> bool {
    true
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Permissions {
    #[serde(default, rename = "shell.execute")]
    pub shell_execute: Vec<String>, // glob patterns under the package dir

    #[serde(default, rename = "fs.read")]
    pub fs_read: Vec<String>, // path globs (may use $pkg_data, $pkg_install, $home)

    #[serde(default, rename = "fs.write")]
    pub fs_write: Vec<String>,

    #[serde(default)]
    pub net: Vec<String>, // URL prefixes

    #[serde(default, rename = "supabase.tables")]
    pub supabase_tables: Vec<String>, // table-name globs

    #[serde(default, rename = "vault.keys")]
    pub vault_keys: Vec<String>, // key-name globs in encrypted vault
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct UiBlock {
    #[serde(default)]
    pub nav: Vec<NavEntry>,
    /// Declarative UI routes contributed by this package. `iframe`-kind routes
    /// are mounted at `/pkg/<id><path>` via the host catch-all, served by the
    /// `pkg_content` HTTP server. `component`-kind routes are documented as
    /// builtin-only (Tasks-style marker installs) and surface as
    /// `<PkgRouteUnmountable />` if a third-party package declares one.
    #[serde(default)]
    pub routes: Vec<UiRoute>,
    #[serde(default, rename = "command_palette")]
    pub command_palette: Vec<CommandPaletteEntry>,
    #[serde(default, rename = "side_pane_viewers")]
    pub side_pane_viewers: Vec<SidePaneViewer>,

    /// Per-directive CSP overrides for the iframe content. Directive name →
    /// list of sources, merged into the host's default policy. Default-deny:
    /// directives not listed here only see the host's defaults.
    /// e.g. `{ "script-src": ["'self'", "'unsafe-inline'"], "connect-src": ["http://127.0.0.1:3105"] }`
    #[serde(default)]
    pub csp: Option<HashMap<String, Vec<String>>>,

    /// Per-directive Permission-Policy values (clipboard, camera, etc.).
    /// Directive name → allowlist sources. Empty / missing = blocked.
    #[serde(default)]
    pub permissions: Option<HashMap<String, Vec<String>>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UiRoute {
    /// Path under the package's UI namespace, e.g. `/dashboard`. The registry
    /// stores it as `pkg://<id><path>` (see UiRoutesRegistry).
    pub path: String,
    /// `iframe` (loaded via the existing iframe content-pane) or `component`
    /// (deferred — registered but not mountable yet).
    pub kind: String,
    /// For `iframe`: a URL or package-relative HTML path. For `component`: an
    /// identifier the FE will resolve in a later phase.
    pub source: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SettingsBlock {
    #[serde(default)]
    pub schema: Vec<SettingsField>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SettingsField {
    pub key: String,
    /// JSON-schema-ish primitive: `string` | `number` | `boolean` | `secret`.
    /// The kernel doesn't validate values against this today (storage is
    /// schemaless JSON); future Settings UI will use it for input rendering.
    #[serde(rename = "type")]
    pub field_type: String,
    pub label: String,
    #[serde(default)]
    pub default: serde_json::Value,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NavEntry {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub section: Option<String>,
    pub route: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandPaletteEntry {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub shortcut: Option<String>,
    pub action: serde_json::Value, // typed later when the palette registry lands
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SidePaneViewer {
    pub id: String,
    pub label: String,
    pub route: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct IykeBlock {
    #[serde(default)]
    pub routes: Vec<IykeRoute>,
    #[serde(default)]
    pub events: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IykeRoute {
    pub method: String,  // "GET" | "POST"
    pub path: String,    // must start with /pkg/<id>/
    pub handler: String, // "sidecar:<name> <subcommand>" | "event:<name>"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CronEntry {
    pub id: String,
    /// 6-field cron expression (sec min hour day month dow) — tokio-cron-scheduler.
    pub expr: String,
    /// Same handler shape as `iyke.routes`: `event:<name>` |
    /// `sidecar:<name> <subcommand>`.
    pub handler: String,
    #[serde(default, rename = "env_from_settings")]
    pub env_from_settings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowBlock {
    pub label: String,
    pub url: String,
    #[serde(default)]
    pub size: Option<[u32; 2]>,
    #[serde(default)]
    pub decorations: Option<bool>,
    #[serde(default)]
    pub menu: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct QueriesBlock {
    #[serde(default, rename = "key_prefixes")]
    pub key_prefixes: Vec<String>,
}

/// Loaded package: parsed manifest plus the absolute path it was loaded from.
/// The kernel passes this to every registry's `register()`.
#[derive(Debug, Clone)]
pub struct Package {
    pub manifest: Manifest,
    pub install_path: PathBuf,
}

impl Package {
    /// Load `<dir>/manifest.json` and parse it.
    pub fn load(install_path: &Path) -> Result<Self> {
        let manifest_path = install_path.join("manifest.json");
        let raw = std::fs::read_to_string(&manifest_path)
            .with_context(|| format!("read {}", manifest_path.display()))?;
        let manifest: Manifest = serde_json::from_str(&raw)
            .with_context(|| format!("parse manifest at {}", manifest_path.display()))?;
        Self::validate(&manifest)?;
        Ok(Self {
            manifest,
            install_path: install_path.to_path_buf(),
        })
    }

    fn validate(m: &Manifest) -> Result<()> {
        if m.id.is_empty() {
            return Err(anyhow!("manifest.id required"));
        }
        // Reverse-DNS sanity check — full validation happens at install time
        // when we also check for collisions with existing packages.
        if !m.id.contains('.') {
            return Err(anyhow!(
                "manifest.id must be reverse-DNS (e.g. com.royalti.{})",
                m.id
            ));
        }
        // ikenga_api must parse as a positive integer string.
        m.ikenga_api
            .parse::<u32>()
            .map_err(|_| anyhow!("manifest.ikenga_api must be a numeric string"))?;
        // Sidecar naming: pa-<pkg-slug>-<sub>. Enforce so per-name shell
        // scopes can't collide across packages.
        let pkg_slug = m.id.replace('.', "-");
        let prefix = format!("pa-{pkg_slug}-");
        for s in &m.sidecars {
            if !s.name.starts_with(&prefix) {
                return Err(anyhow!(
                    "sidecar name `{}` must start with `{prefix}`",
                    s.name
                ));
            }
        }
        Ok(())
    }

    /// Compatibility check: host supports {IKENGA_API_VERSION, that-1}.
    pub fn is_compatible(&self) -> bool {
        let api: u32 = match self.manifest.ikenga_api.parse() {
            Ok(v) => v,
            Err(_) => return false,
        };
        api >= IKENGA_API_MIN_SUPPORTED && api <= IKENGA_API_VERSION
    }

    /// Slug form of the id, safe for filenames and Tauri capability identifiers.
    pub fn slug(&self) -> String {
        self.manifest.id.replace('.', "-")
    }

    /// Resolve a package-relative path declared in the manifest to an absolute
    /// path under `install_path`. Returns Err if the resolved path escapes
    /// `install_path` (defends against `../` in manifest entries).
    pub fn resolve_relative(&self, rel: &str) -> Result<PathBuf> {
        let joined = self.install_path.join(rel);
        let canonical = joined
            .canonicalize()
            .with_context(|| format!("canonicalize {}", joined.display()))?;
        let install_canon = self.install_path.canonicalize()?;
        if !canonical.starts_with(&install_canon) {
            return Err(anyhow!("manifest path `{}` escapes install dir", rel));
        }
        Ok(canonical)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn minimal() -> Manifest {
        Manifest {
            id: "com.royalti.test".into(),
            name: "Test".into(),
            version: "0.1.0".into(),
            ikenga_api: "1".into(),
            kind: None,
            author: None,
            targets: vec![],
            skills: None,
            commands: None,
            agents: None,
            mcp: vec![],
            sidecars: vec![],
            permissions: Permissions::default(),
            migrations: None,
            settings: None,
            ui: None,
            iyke: None,
            cron: vec![],
            window: None,
            queries: None,
            capabilities: None,
            engine: None,
        }
    }

    #[test]
    fn rejects_bad_id() {
        let mut m = minimal();
        m.id = "no-dots".into();
        assert!(Package::validate(&m).is_err());
    }

    #[test]
    fn rejects_bad_sidecar_name() {
        let mut m = minimal();
        m.sidecars.push(SidecarSpec {
            name: "wrong-prefix".into(),
            bin: "bin/x".into(),
            stdio: "json".into(),
            restart_when_changed: vec![],
            auto_restart: true,
        });
        assert!(Package::validate(&m).is_err());
    }

    #[test]
    fn ui_block_accepts_csp_and_permissions() {
        let json = r#"{
            "id": "com.royalti.iframecsptest",
            "name": "T", "version": "0.1.0", "ikenga_api": "1",
            "ui": {
                "routes": [{"path":"/x","kind":"iframe","source":"dist/index.html"}],
                "csp": {"script-src": ["'self'", "'unsafe-inline'"]},
                "permissions": {"clipboard-read": ["'self'"]}
            }
        }"#;
        let m: Manifest = serde_json::from_str(json).expect("parse");
        let ui = m.ui.expect("ui block present");
        let csp = ui.csp.expect("csp parsed");
        assert_eq!(
            csp.get("script-src").unwrap(),
            &vec!["'self'".to_string(), "'unsafe-inline'".to_string()]
        );
        let perms = ui.permissions.expect("permissions parsed");
        assert_eq!(
            perms.get("clipboard-read").unwrap(),
            &vec!["'self'".to_string()]
        );
    }

    #[test]
    fn ui_block_csp_and_permissions_optional() {
        let json = r#"{
            "id": "com.royalti.minimalui",
            "name": "T", "version": "0.1.0", "ikenga_api": "1",
            "ui": {"routes": [{"path":"/x","kind":"iframe","source":"dist/index.html"}]}
        }"#;
        let m: Manifest = serde_json::from_str(json).expect("parse");
        let ui = m.ui.expect("ui block present");
        assert!(ui.csp.is_none());
        assert!(ui.permissions.is_none());
    }

    #[test]
    fn mcp_lifecycle_defaults_to_per_call() {
        let json = r#"{
            "id": "com.royalti.mcpdef",
            "name": "T", "version": "0.1.0", "ikenga_api": "1",
            "mcp": [{"name":"e","command":"node","args":["s.js"]}]
        }"#;
        let m: Manifest = serde_json::from_str(json).expect("parse");
        let s = &m.mcp[0];
        assert!(s.lifecycle.is_none());
        assert!(!s.is_long_lived());
    }

    #[test]
    fn mcp_lifecycle_long_lived_parses() {
        let json = r#"{
            "id": "com.royalti.mcplong",
            "name": "T", "version": "0.1.0", "ikenga_api": "1",
            "mcp": [{"name":"e","command":"node","args":["s.js"],"lifecycle":"long-lived"}]
        }"#;
        let m: Manifest = serde_json::from_str(json).expect("parse");
        assert!(m.mcp[0].is_long_lived());
    }

    #[test]
    fn mcp_lifecycle_unknown_value_treated_as_per_call() {
        let json = r#"{
            "id": "com.royalti.mcpunk",
            "name": "T", "version": "0.1.0", "ikenga_api": "1",
            "mcp": [{"name":"e","command":"node","args":["s.js"],"lifecycle":"weird"}]
        }"#;
        let m: Manifest = serde_json::from_str(json).expect("parse");
        assert!(!m.mcp[0].is_long_lived());
    }

    #[test]
    fn engine_block_parses_full_shape() {
        let json = r#"{
            "id": "com.ikenga.engine-claude-code",
            "name": "Claude Code Engine",
            "version": "0.1.0",
            "ikenga_api": "1",
            "kind": "engine",
            "engine": {
                "agentId": "claude-code",
                "display": "Claude Code",
                "capabilities": {
                    "streaming": true,
                    "toolUse": true,
                    "thinking": true,
                    "artifacts": true,
                    "fileAttachments": true,
                    "imageInput": true,
                    "slashCommands": true,
                    "modelSwitching": true,
                    "promptCaching": true,
                    "agenticTools": true,
                    "mcp": true,
                    "sessionResume": true
                },
                "onboarding": {
                    "requiredVaultKeys": ["ANTHROPIC_API_KEY"],
                    "requiredEnvVars": [],
                    "authCommand": "claude login",
                    "docsUrl": "https://docs.anthropic.com/en/docs/claude-code"
                }
            }
        }"#;
        let m: Manifest = serde_json::from_str(json).expect("parse");
        let engine = m.engine.expect("engine block present");
        assert_eq!(engine.agent_id, "claude-code");
        assert_eq!(engine.display.as_deref(), Some("Claude Code"));
        assert!(engine.capabilities.streaming);
        assert!(engine.capabilities.mcp);
        assert_eq!(
            engine.onboarding.required_vault_keys,
            vec!["ANTHROPIC_API_KEY".to_string()]
        );
        assert_eq!(
            engine.onboarding.auth_command.as_deref(),
            Some("claude login")
        );
        assert!(engine.onboarding.docs_url.is_some());
    }

    #[test]
    fn engine_block_is_optional() {
        let json = r#"{
            "id": "com.ikenga.studio",
            "name": "Studio",
            "version": "0.1.0",
            "ikenga_api": "1"
        }"#;
        let m: Manifest = serde_json::from_str(json).expect("parse");
        assert!(m.engine.is_none());
    }

    #[test]
    fn engine_block_minimal_with_default_onboarding() {
        // Onboarding omitted entirely — defaults to empty vec lists.
        let json = r#"{
            "id": "com.ikenga.engine-noop",
            "name": "No-op",
            "version": "0.1.0",
            "ikenga_api": "1",
            "engine": {
                "agentId": "noop",
                "capabilities": {
                    "streaming": false,
                    "toolUse": false,
                    "thinking": false,
                    "artifacts": false,
                    "fileAttachments": false,
                    "imageInput": false,
                    "slashCommands": false,
                    "modelSwitching": false,
                    "promptCaching": false,
                    "agenticTools": false,
                    "mcp": false,
                    "sessionResume": false
                }
            }
        }"#;
        let m: Manifest = serde_json::from_str(json).expect("parse");
        let engine = m.engine.expect("engine block present");
        assert_eq!(engine.agent_id, "noop");
        assert!(engine.display.is_none());
        assert!(engine.onboarding.required_vault_keys.is_empty());
        assert!(engine.onboarding.required_env_vars.is_empty());
        assert!(engine.onboarding.auth_command.is_none());
    }

    #[test]
    fn engine_block_rejects_missing_capabilities() {
        let json = r#"{
            "id": "com.ikenga.engine-broken",
            "name": "Broken",
            "version": "0.1.0",
            "ikenga_api": "1",
            "engine": {"agentId": "broken"}
        }"#;
        let result: Result<Manifest, _> = serde_json::from_str(json);
        assert!(result.is_err(), "expected error when capabilities missing");
    }

    #[test]
    fn engine_block_rejects_unknown_capability_field() {
        // deny_unknown_fields on AgentCapabilities — guards lockstep with Zod.
        let json = r#"{
            "id": "com.ikenga.engine-future",
            "name": "Future",
            "version": "0.1.0",
            "ikenga_api": "1",
            "engine": {
                "agentId": "future",
                "capabilities": {
                    "streaming": true,
                    "toolUse": false,
                    "thinking": false,
                    "artifacts": false,
                    "fileAttachments": false,
                    "imageInput": false,
                    "slashCommands": false,
                    "modelSwitching": false,
                    "promptCaching": false,
                    "agenticTools": false,
                    "mcp": false,
                    "sessionResume": false,
                    "telepathy": true
                }
            }
        }"#;
        let result: Result<Manifest, _> = serde_json::from_str(json);
        assert!(
            result.is_err(),
            "expected error on unknown capability field"
        );
    }

    #[test]
    fn accepts_well_formed_sidecar() {
        let mut m = minimal();
        m.sidecars.push(SidecarSpec {
            name: "pa-com-royalti-test-main".into(),
            bin: "bin/x".into(),
            stdio: "json".into(),
            restart_when_changed: vec![],
            auto_restart: true,
        });
        assert!(Package::validate(&m).is_ok());
    }

    #[test]
    fn sidecar_spec_defaults_restart_when_changed_and_auto_restart() {
        // Phase 9: legacy manifests without these fields stay valid; defaults
        // are empty globs + auto_restart=true (existing supervisor behavior).
        let json = r#"{
            "id": "com.royalti.legacysidecar",
            "name": "T", "version": "0.1.0", "ikenga_api": "1",
            "sidecars": [{"name": "pa-com-royalti-legacysidecar-main", "bin": "bin/x"}]
        }"#;
        let m: Manifest = serde_json::from_str(json).expect("parse");
        let s = &m.sidecars[0];
        assert_eq!(s.stdio, "json");
        assert!(s.restart_when_changed.is_empty());
        assert!(s.auto_restart);
    }

    #[test]
    fn sidecar_spec_parses_restart_when_changed_and_auto_restart() {
        let json = r#"{
            "id": "com.royalti.watchsidecar",
            "name": "T", "version": "0.1.0", "ikenga_api": "1",
            "sidecars": [{
                "name": "pa-com-royalti-watchsidecar-main",
                "bin": "bin/x",
                "restart_when_changed": ["src/**/*.ts", "config.toml"],
                "auto_restart": false
            }]
        }"#;
        let m: Manifest = serde_json::from_str(json).expect("parse");
        let s = &m.sidecars[0];
        assert_eq!(
            s.restart_when_changed,
            vec!["src/**/*.ts".to_string(), "config.toml".to_string()]
        );
        assert!(!s.auto_restart);
    }
}
