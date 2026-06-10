//! Phase 9 — manifest trust gating.
//!
//! Pkgs that declare *sensitive* permissions (`shell.execute` non-empty, or
//! any `fs.write` glob that resolves outside the pkg's `$pkg_data` sandbox)
//! must be explicitly approved by the user before their MCP tools/call
//! invocations are honored. Everything else (skill packs, sandbox-only
//! writers, iframe-only UI, supabase-only readers) is auto-trusted on
//! install with no prompt.
//!
//! Storage piggybacks on `pkg_permissions_granted`. The trust grant is one
//! row per pkg with `scope_kind = '__manifest_trust'` (sentinel; never
//! collides with real capability scope kinds). `scope_value` is
//! `<sha256(snapshot_json)>` so a manifest update that changes the
//! sensitive perms invalidates the grant via mismatched value. The new
//! `version` column records the manifest version the grant was issued
//! against; `trust_state` toggles `granted` ↔ `revoked`.
//!
//! Auto-trust criterion (locked decision): pkg `source.kind = "builtin"`
//! AND `manifest.id` starts with `com.ikenga.`. We trust pkgs we ship; we
//! do not trust pkgs that merely *name* themselves like one of ours.
//!
//! Dev-mode bypass (2026-05-18): pkgs with `source.kind = "dev"` (mounted
//! via `ikenga dev <path>`) are also auto-trusted regardless of id
//! namespace. Sensitive perms still emit a `log::warn!` so the dev sees
//! what they've opted into, but no modal blocks the loop. Dev sources
//! never persist as `Dev` across reboots — boot reconstructs them as
//! plain `Local` — so this can't accidentally smuggle elevated trust
//! into a production install.

use std::path::PathBuf;

use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;

use crate::pkg::manifest::{Package, Permissions};
use crate::pkg::source::InstallSource;

/// Sentinel scope_kind reserved for manifest trust grants. Never appears in
/// the manifest's declared `permissions.*` blocks; the permissions registry
/// only writes `fs.read`/`fs.write`/`shell.execute` rows.
const TRUST_SCOPE_KIND: &str = "__manifest_trust";

/// Plain-English summary of one declared permission set, for the trust
/// dialog and the `iyke_pkg_trust_*` MCP tools. Lists only the entries
/// that triggered the trust requirement, not the full perms block.
#[derive(Debug, Clone, Serialize)]
pub struct PermsSummary {
    pub shell_execute: Vec<String>,
    pub fs_write_outside_sandbox: Vec<String>,
    pub net: Vec<String>,
    pub vault_keys: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum NeedsApprovalReason {
    /// First time the user has seen this pkg.
    Never,
    /// Pkg was previously trusted but the sensitive-perms snapshot
    /// changed. `added` / `removed` are the diff against the prior grant.
    PermissionsChanged {
        prior_version: String,
        added: Vec<String>,
        removed: Vec<String>,
    },
    /// Existing grant explicitly revoked by the user.
    Revoked,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum TrustState {
    /// `source.kind = "builtin"` AND id starts with `com.ikenga.`.
    /// No row required; never expires.
    AutoTrusted,
    /// Pkg declares no sensitive perms — auto-granted on install with no
    /// prompt. Same surface as a user-approved row from the FE's POV.
    AutoGranted,
    /// User explicitly approved this version's sensitive perms.
    Granted { version: String, granted_at_ms: i64 },
    /// Approval needed. Caller must surface the prompt.
    NeedsApproval {
        reason: NeedsApprovalReason,
        current_version: String,
    },
}

impl TrustState {
    /// True when this state allows MCP tools/call to proceed.
    pub fn is_allowed(&self) -> bool {
        matches!(
            self,
            TrustState::AutoTrusted | TrustState::AutoGranted | TrustState::Granted { .. }
        )
    }

    pub fn label(&self) -> &'static str {
        match self {
            TrustState::AutoTrusted => "auto_trusted",
            TrustState::AutoGranted => "auto_granted",
            TrustState::Granted { .. } => "granted",
            TrustState::NeedsApproval { .. } => "needs_approval",
        }
    }
}

/// Stable wire form for a sensitive-perms snapshot. The hex sha256 of this
/// string is what we store in `scope_value`; mismatch ⇒ permissions changed.
fn snapshot_json(perms: &PermsSummary) -> String {
    // Sort each list so reordering doesn't invalidate trust.
    let mut shell = perms.shell_execute.clone();
    let mut fsw = perms.fs_write_outside_sandbox.clone();
    let mut net = perms.net.clone();
    let mut vk = perms.vault_keys.clone();
    shell.sort();
    fsw.sort();
    net.sort();
    vk.sort();
    serde_json::to_string(&serde_json::json!({
        "shell_execute": shell,
        "fs_write_outside_sandbox": fsw,
        "net": net,
        "vault_keys": vk,
    }))
    .expect("snapshot json")
}

fn snapshot_hash(perms: &PermsSummary) -> String {
    let mut hasher = Sha256::new();
    hasher.update(snapshot_json(perms).as_bytes());
    hex::encode(hasher.finalize())
}

/// Resolve `$pkg_data` for a given pkg id under the supplied app data root.
/// Mirrors the path computed by `permissions::resolve_path` so the "outside
/// sandbox" check stays consistent with what the kernel actually grants.
fn pkg_data_dir(app_data_dir: &PathBuf, pkg_id: &str) -> PathBuf {
    app_data_dir.join("pkgs").join(pkg_id).join("data")
}

/// True when this raw `fs.write` glob resolves to a path outside the pkg's
/// `$pkg_data` sandbox. `$pkg_data` and `$pkg_install` are sandbox-aligned
/// (kernel-managed); anything else (`$home`, absolute paths) is sensitive.
fn fs_write_is_sensitive(raw: &str) -> bool {
    !raw.starts_with("$pkg_data") && !raw.starts_with("$pkg_install")
}

/// Compute the sensitive-perms summary for a manifest. Only the fields that
/// actually triggered the trust requirement get populated; everything else
/// is empty.
pub fn summarize_sensitive(perms: &Permissions) -> PermsSummary {
    let fs_write_outside_sandbox = perms
        .fs_write
        .iter()
        .filter(|raw| fs_write_is_sensitive(raw))
        .cloned()
        .collect::<Vec<_>>();
    PermsSummary {
        shell_execute: perms.shell_execute.clone(),
        fs_write_outside_sandbox,
        net: perms.net.clone(),
        vault_keys: perms.vault_keys.clone(),
    }
}

/// True when the manifest declares perms that require explicit user trust.
pub fn requires_trust(perms: &Permissions) -> bool {
    let s = summarize_sensitive(perms);
    !s.shell_execute.is_empty() || !s.fs_write_outside_sandbox.is_empty()
}

/// Same as `pkg_id.starts_with("com.ikenga.")` — but explicit so the call
/// site reads as the policy decision, not a string check.
fn id_in_ikenga_namespace(pkg_id: &str) -> bool {
    pkg_id.starts_with("com.ikenga.")
}

/// Auto-trust policy:
///
/// - `source.kind = "builtin"` AND id in `com.ikenga.*` namespace, OR
/// - `source.kind = "dev"` — dev-mode mounts via `ikenga dev` bypass the
///   modal regardless of pkg id (sensitive perms still log::warn).
///
/// Neither path alone is insufficient for the builtin case: an attacker
/// who got their pkg into `builtin-pkgs/` still can't masquerade as
/// `com.ikenga.*`, and a sideloaded pkg that names itself `com.ikenga.X`
/// doesn't count.
pub fn is_auto_trusted(pkg_id: &str, source: &InstallSource) -> bool {
    if source.is_dev() {
        return true;
    }
    source.is_builtin() && id_in_ikenga_namespace(pkg_id)
}

/// Pull the latest trust row for a pkg, if any.
async fn fetch_trust_row(
    pool: &SqlitePool,
    pkg_id: &str,
) -> Result<Option<(String, String, String, i64)>> {
    // (version, scope_value (hash), trust_state, granted_at)
    let row: Option<(Option<String>, String, String, i64)> = sqlx::query_as(
        "SELECT version, scope_value, trust_state, granted_at
           FROM pkg_permissions_granted
          WHERE pkg_id = ? AND scope_kind = ?
          ORDER BY granted_at DESC
          LIMIT 1",
    )
    .bind(pkg_id)
    .bind(TRUST_SCOPE_KIND)
    .fetch_optional(pool)
    .await
    .context("read pkg_permissions_granted (trust)")?;
    Ok(row.map(|(v, s, st, t)| (v.unwrap_or_default(), s, st, t)))
}

/// Evaluate the trust state for an installed pkg.
///
/// Pure function over the supplied inputs — no Tauri / app-handle reads. The
/// caller threads in `app_data_dir` so the "outside sandbox" calculation is
/// deterministic regardless of test harness.
pub async fn evaluate(
    pool: &SqlitePool,
    pkg: &Package,
    source: &InstallSource,
    app_data_dir: &PathBuf,
) -> Result<TrustState> {
    let pkg_id = &pkg.manifest.id;
    let version = pkg.manifest.version.clone();

    if is_auto_trusted(pkg_id, source) {
        // Dev-mode trust bypass: surface the elevated perms in the log so the
        // dev sees what they've opted into without a modal blocking the loop.
        // Sticks at WARN so the line is hard to miss in the shell's stderr.
        if source.is_dev() {
            let perms = &pkg.manifest.permissions;
            if requires_trust(perms) {
                let s = summarize_sensitive(perms);
                log::warn!(
                    "[pkg_trust] dev pkg `{pkg_id}` auto-trusted with sensitive perms: \
                     shell.execute={:?} fs.write_outside_sandbox={:?}",
                    s.shell_execute,
                    s.fs_write_outside_sandbox
                );
            }
        }
        return Ok(TrustState::AutoTrusted);
    }

    let perms = &pkg.manifest.permissions;
    if !requires_trust(perms) {
        return Ok(TrustState::AutoGranted);
    }

    let summary = summarize_sensitive(perms);
    let _sandbox = pkg_data_dir(app_data_dir, pkg_id); // currently unused; reserved for future absolute-path normalization
    let current_hash = snapshot_hash(&summary);

    let Some((row_version, row_hash, trust_state, granted_at)) =
        fetch_trust_row(pool, pkg_id).await?
    else {
        return Ok(TrustState::NeedsApproval {
            reason: NeedsApprovalReason::Never,
            current_version: version,
        });
    };

    if trust_state == "revoked" {
        return Ok(TrustState::NeedsApproval {
            reason: NeedsApprovalReason::Revoked,
            current_version: version,
        });
    }

    if row_hash == current_hash {
        return Ok(TrustState::Granted {
            version: row_version,
            granted_at_ms: granted_at,
        });
    }

    // Hash mismatch — diff the prior summary against current. We don't
    // re-store the prior summary; instead derive added/removed by parsing
    // the prior row's hash isn't possible, so we fall back to "the perms
    // changed since version <prior>" without a granular diff. The dialog
    // shows the full current set highlighted as new.
    Ok(TrustState::NeedsApproval {
        reason: NeedsApprovalReason::PermissionsChanged {
            prior_version: row_version,
            added: vec![],
            removed: vec![],
        },
        current_version: version,
    })
}

/// Insert a granted row capturing the current sensitive-perms snapshot.
/// Idempotent under PRIMARY KEY `(pkg_id, scope_kind, scope_value)` —
/// re-granting the same hash silently bumps `granted_at`.
pub async fn grant(
    pool: &SqlitePool,
    pkg_id: &str,
    version: &str,
    summary: &PermsSummary,
) -> Result<()> {
    // Mark prior rows revoked first so a subsequent evaluate() reads the new
    // row by `granted_at DESC`.
    sqlx::query(
        "UPDATE pkg_permissions_granted
            SET trust_state = 'revoked'
          WHERE pkg_id = ? AND scope_kind = ? AND trust_state = 'granted'",
    )
    .bind(pkg_id)
    .bind(TRUST_SCOPE_KIND)
    .execute(pool)
    .await
    .context("revoke prior trust rows before grant")?;

    let hash = snapshot_hash(summary);
    let now = chrono::Utc::now().timestamp_millis();
    sqlx::query(
        "INSERT OR REPLACE INTO pkg_permissions_granted
            (pkg_id, scope_kind, scope_value, granted_at, version, trust_state)
            VALUES (?, ?, ?, ?, ?, 'granted')",
    )
    .bind(pkg_id)
    .bind(TRUST_SCOPE_KIND)
    .bind(&hash)
    .bind(now)
    .bind(version)
    .execute(pool)
    .await
    .context("insert pkg_permissions_granted (trust)")?;
    Ok(())
}

/// Mark all granted rows for this pkg as revoked. Subsequent evaluate()
/// returns NeedsApproval { reason: Revoked }.
pub async fn revoke(pool: &SqlitePool, pkg_id: &str) -> Result<()> {
    sqlx::query(
        "UPDATE pkg_permissions_granted
            SET trust_state = 'revoked'
          WHERE pkg_id = ? AND scope_kind = ? AND trust_state = 'granted'",
    )
    .bind(pkg_id)
    .bind(TRUST_SCOPE_KIND)
    .execute(pool)
    .await
    .context("revoke trust rows")?;
    Ok(())
}

/// Convenience: structured error returned by MCP call sites when a tools/call
/// hits an untrusted pkg. The string form is what propagates through the
/// existing `anyhow!` plumbing; FE / agents parse the prefix to detect the
/// trust-required case.
pub fn trust_required_error(pkg_id: &str) -> anyhow::Error {
    anyhow!(
        "trust_required: pkg `{pkg_id}` is awaiting user approval — \
         grant via Settings → Pkgs → Trust"
    )
}

/// True when an `anyhow::Error` was produced by `trust_required_error`. Used
/// by the supervisor surface to translate into a `LifecycleKind::Error`.
pub fn is_trust_required_error(e: &anyhow::Error) -> bool {
    e.to_string().starts_with("trust_required:")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pkg::manifest::{Manifest, Permissions};
    use std::path::PathBuf;

    fn pkg_with_perms(id: &str, perms: Permissions) -> Package {
        Package {
            manifest: Manifest {
                id: id.into(),
                name: "T".into(),
                version: "0.1.0".into(),
                ikenga_api: "1".into(),
                kind: None,
                author: None,
                targets: vec![],
                mcp: vec![],
                sidecars: vec![],
                permissions: perms,
                migrations: None,
                settings: None,
                ui: None,
                iyke: None,
                cron: vec![],
                window: None,
                queries: None,
                capabilities: None,
                engine: None,
                screenshots: vec![],
                requires: vec![],
                signature: None,
            },
            install_path: PathBuf::from("/tmp"),
        }
    }

    #[test]
    fn auto_trust_requires_both_builtin_source_and_ikenga_id() {
        // Both ✓ → auto-trust.
        assert!(is_auto_trusted("com.ikenga.iyke", &InstallSource::Builtin));
        // Builtin source, third-party id → NOT auto-trusted (an attacker
        // who got their pkg into builtin-pkgs/ still can't masquerade).
        assert!(!is_auto_trusted("com.evil.miner", &InstallSource::Builtin));
        // ikenga id, non-builtin source → NOT auto-trusted (a sideloaded
        // pkg that names itself com.ikenga.X doesn't count).
        assert!(!is_auto_trusted(
            "com.ikenga.evil",
            &InstallSource::Local {
                path: "/tmp".into()
            }
        ));
        // Neither → NOT auto-trusted.
        assert!(!is_auto_trusted(
            "com.royalti.studio",
            &InstallSource::Registry {
                url: "u".into(),
                publisher_key: None,
            }
        ));
    }

    #[test]
    fn dev_source_auto_trusts_regardless_of_id_namespace() {
        // Dev mode bypasses the com.ikenga.* requirement — a developer's
        // `com.example.thing` symlinked via `ikenga dev` is still trusted.
        assert!(is_auto_trusted(
            "com.example.dashboard",
            &InstallSource::Dev {
                path: "/home/me/code/dashboard".into()
            }
        ));
        // And a dev pkg using the reserved namespace is also fine — devs
        // building first-party builtins should be able to test them this way.
        assert!(is_auto_trusted(
            "com.ikenga.studio",
            &InstallSource::Dev {
                path: "/home/me/code/studio".into()
            }
        ));
        // Local (non-dev) still requires both source AND namespace as before.
        assert!(!is_auto_trusted(
            "com.example.dashboard",
            &InstallSource::Local {
                path: "/home/me/code/dashboard".into()
            }
        ));
    }

    #[test]
    fn fs_write_is_sandbox_only_when_under_pkg_placeholders() {
        assert!(!fs_write_is_sensitive("$pkg_data/cache/**"));
        assert!(!fs_write_is_sensitive("$pkg_install/templates/**"));
        assert!(fs_write_is_sensitive("$home/Movies/Ikenga/**"));
        assert!(fs_write_is_sensitive("/etc/passwd"));
    }

    #[test]
    fn requires_trust_skips_skill_packs() {
        let perms = Permissions::default();
        assert!(!requires_trust(&perms));
    }

    #[test]
    fn requires_trust_fires_on_shell_execute() {
        let mut perms = Permissions::default();
        perms.shell_execute.push("bin/run".into());
        assert!(requires_trust(&perms));
    }

    #[test]
    fn requires_trust_fires_on_unsandboxed_fs_write_only() {
        let mut perms = Permissions::default();
        perms.fs_write.push("$pkg_data/cache/**".into());
        // Sandbox-only writers are NOT sensitive.
        assert!(!requires_trust(&perms));
        perms.fs_write.push("$home/Movies/Ikenga/**".into());
        assert!(requires_trust(&perms));
    }

    #[test]
    fn requires_trust_does_not_fire_on_net_alone() {
        // Decision: `net` alone doesn't trigger the prompt (read decisions
        // log: "Any non-empty shell.execute, fs.write outside $pkg_data").
        // It's still surfaced in the dialog when a prompt fires for
        // another reason, but it's not a trigger by itself.
        let mut perms = Permissions::default();
        perms.net.push("https://api.openai.com/".into());
        assert!(!requires_trust(&perms));
    }

    #[test]
    fn snapshot_hash_is_order_insensitive() {
        let a = PermsSummary {
            shell_execute: vec!["b".into(), "a".into()],
            fs_write_outside_sandbox: vec![],
            net: vec![],
            vault_keys: vec![],
        };
        let b = PermsSummary {
            shell_execute: vec!["a".into(), "b".into()],
            fs_write_outside_sandbox: vec![],
            net: vec![],
            vault_keys: vec![],
        };
        assert_eq!(snapshot_hash(&a), snapshot_hash(&b));
    }

    #[test]
    fn snapshot_hash_changes_when_perms_change() {
        let a = PermsSummary {
            shell_execute: vec!["bin/run".into()],
            fs_write_outside_sandbox: vec![],
            net: vec![],
            vault_keys: vec![],
        };
        let b = PermsSummary {
            shell_execute: vec!["bin/run".into(), "scripts/sh".into()],
            fs_write_outside_sandbox: vec![],
            net: vec![],
            vault_keys: vec![],
        };
        assert_ne!(snapshot_hash(&a), snapshot_hash(&b));
    }

    async fn open_test_pool() -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:")
            .await
            .expect("open in-memory sqlite");
        // Minimum schema: parent table + the trust columns we use.
        sqlx::query(
            "CREATE TABLE pkg_installed (
                id TEXT PRIMARY KEY,
                version TEXT NOT NULL,
                ikenga_api TEXT NOT NULL,
                manifest_json TEXT NOT NULL,
                install_path TEXT NOT NULL,
                installed_at INTEGER NOT NULL,
                enabled INTEGER NOT NULL,
                source_json TEXT NOT NULL,
                project_id TEXT
             )",
        )
        .execute(&pool)
        .await
        .expect("create pkg_installed");
        sqlx::query(
            "CREATE TABLE pkg_permissions_granted (
                pkg_id TEXT NOT NULL,
                scope_kind TEXT NOT NULL,
                scope_value TEXT NOT NULL,
                granted_at INTEGER NOT NULL,
                version TEXT,
                trust_state TEXT NOT NULL DEFAULT 'granted',
                PRIMARY KEY (pkg_id, scope_kind, scope_value)
             )",
        )
        .execute(&pool)
        .await
        .expect("create pkg_permissions_granted");
        sqlx::query(
            "INSERT INTO pkg_installed
              (id, version, ikenga_api, manifest_json, install_path, installed_at, enabled, source_json, project_id)
             VALUES ('com.evil.studio', '0.1.0', '1', '{}', '/tmp', 0, 1,
                     '{\"kind\":\"local\",\"path\":\"/tmp\"}', NULL)",
        )
        .execute(&pool)
        .await
        .expect("seed pkg_installed");
        pool
    }

    #[tokio::test]
    async fn evaluate_returns_auto_trusted_for_ikenga_builtin() {
        let pool = open_test_pool().await;
        let pkg = pkg_with_perms("com.ikenga.iyke", Permissions::default());
        let state = evaluate(&pool, &pkg, &InstallSource::Builtin, &PathBuf::from("/tmp"))
            .await
            .expect("evaluate");
        assert!(matches!(state, TrustState::AutoTrusted));
        assert!(state.is_allowed());
    }

    #[tokio::test]
    async fn evaluate_returns_auto_granted_for_skill_pack() {
        let pool = open_test_pool().await;
        let pkg = pkg_with_perms("com.evil.studio", Permissions::default());
        let state = evaluate(
            &pool,
            &pkg,
            &InstallSource::Local {
                path: "/tmp".into(),
            },
            &PathBuf::from("/tmp"),
        )
        .await
        .expect("evaluate");
        assert!(matches!(state, TrustState::AutoGranted));
        assert!(state.is_allowed());
    }

    #[tokio::test]
    async fn evaluate_returns_needs_approval_never_for_new_sensitive_pkg() {
        let pool = open_test_pool().await;
        let mut perms = Permissions::default();
        perms.shell_execute.push("bin/run".into());
        let pkg = pkg_with_perms("com.evil.studio", perms);
        let state = evaluate(
            &pool,
            &pkg,
            &InstallSource::Local {
                path: "/tmp".into(),
            },
            &PathBuf::from("/tmp"),
        )
        .await
        .expect("evaluate");
        match state {
            TrustState::NeedsApproval {
                reason: NeedsApprovalReason::Never,
                ..
            } => {}
            other => panic!("expected NeedsApproval/Never, got {other:?}"),
        }
        let s = evaluate(
            &pool,
            &pkg,
            &InstallSource::Local {
                path: "/tmp".into(),
            },
            &PathBuf::from("/tmp"),
        )
        .await
        .expect("evaluate");
        assert!(!s.is_allowed());
    }

    #[tokio::test]
    async fn grant_then_evaluate_returns_granted_then_revoke_flips() {
        let pool = open_test_pool().await;
        let mut perms = Permissions::default();
        perms.shell_execute.push("bin/run".into());
        let pkg = pkg_with_perms("com.evil.studio", perms);

        let summary = summarize_sensitive(&pkg.manifest.permissions);
        grant(&pool, &pkg.manifest.id, &pkg.manifest.version, &summary)
            .await
            .expect("grant");

        let state = evaluate(
            &pool,
            &pkg,
            &InstallSource::Local {
                path: "/tmp".into(),
            },
            &PathBuf::from("/tmp"),
        )
        .await
        .expect("evaluate");
        match state {
            TrustState::Granted { ref version, .. } => assert_eq!(version, "0.1.0"),
            other => panic!("expected Granted, got {other:?}"),
        }
        assert!(state.is_allowed());

        revoke(&pool, &pkg.manifest.id).await.expect("revoke");
        let state = evaluate(
            &pool,
            &pkg,
            &InstallSource::Local {
                path: "/tmp".into(),
            },
            &PathBuf::from("/tmp"),
        )
        .await
        .expect("evaluate");
        match state {
            TrustState::NeedsApproval {
                reason: NeedsApprovalReason::Revoked,
                ..
            } => {}
            other => panic!("expected NeedsApproval/Revoked, got {other:?}"),
        }
        assert!(!state.is_allowed());
    }

    #[tokio::test]
    async fn grant_then_perms_change_invalidates_via_hash_mismatch() {
        let pool = open_test_pool().await;
        let mut perms = Permissions::default();
        perms.shell_execute.push("bin/run".into());
        let pkg_v1 = pkg_with_perms("com.evil.studio", perms);
        let summary = summarize_sensitive(&pkg_v1.manifest.permissions);
        grant(
            &pool,
            &pkg_v1.manifest.id,
            &pkg_v1.manifest.version,
            &summary,
        )
        .await
        .expect("grant v1");

        // v2 widens shell.execute — should re-prompt.
        let mut perms2 = Permissions::default();
        perms2.shell_execute.push("bin/run".into());
        perms2.shell_execute.push("scripts/sh".into());
        let mut pkg_v2 = pkg_with_perms("com.evil.studio", perms2);
        pkg_v2.manifest.version = "0.2.0".into();

        let state = evaluate(
            &pool,
            &pkg_v2,
            &InstallSource::Local {
                path: "/tmp".into(),
            },
            &PathBuf::from("/tmp"),
        )
        .await
        .expect("evaluate v2");
        match state {
            TrustState::NeedsApproval {
                reason:
                    NeedsApprovalReason::PermissionsChanged {
                        ref prior_version, ..
                    },
                ref current_version,
            } => {
                assert_eq!(prior_version, "0.1.0");
                assert_eq!(current_version, "0.2.0");
            }
            other => panic!("expected PermissionsChanged, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn version_bump_alone_keeps_grant_when_perms_unchanged() {
        let pool = open_test_pool().await;
        let mut perms = Permissions::default();
        perms.shell_execute.push("bin/run".into());
        let pkg_v1 = pkg_with_perms("com.evil.studio", perms.clone());
        let summary = summarize_sensitive(&pkg_v1.manifest.permissions);
        grant(
            &pool,
            &pkg_v1.manifest.id,
            &pkg_v1.manifest.version,
            &summary,
        )
        .await
        .expect("grant v1");

        // v2: same perms set, bumped version — must stay trusted.
        let mut pkg_v2 = pkg_with_perms("com.evil.studio", perms);
        pkg_v2.manifest.version = "0.2.0".into();

        let state = evaluate(
            &pool,
            &pkg_v2,
            &InstallSource::Local {
                path: "/tmp".into(),
            },
            &PathBuf::from("/tmp"),
        )
        .await
        .expect("evaluate v2");
        assert!(matches!(state, TrustState::Granted { .. }));
        assert!(state.is_allowed());
    }
}
