//! Tauri commands for the pkg content server.
//!
//! Two entry points:
//!
//! - `pkg_content_html(pkgId, source)` — preferred. Returns the HTML body
//!   (with `<base href>` injected) so the frontend can `srcdoc=` it into the
//!   iframe. This is the workaround for the documented Linux/WebKitGTK bug
//!   where iframe-document loads from any non-https origin (custom protocol
//!   *or* http loopback) get blocked even though subresource fetches succeed
//!   — see https://github.com/tauri-apps/tauri/issues/12767. Loading the
//!   iframe document via `srcdoc` causes it to inherit the parent origin so
//!   the bug doesn't fire; subresources still come from
//!   `http://127.0.0.1:<port>/<pkgId>/<token>/...` via the existing axum
//!   server, which works fine on every platform.
//!
//! - `pkg_content_url(pkgId)` — legacy. Mints a token and returns the URL
//!   without reading any file. Useful for tests that want to assert the
//!   server is alive or for future call sites that need direct asset URLs.
//!
//! `pkg_content_revoke(token)` releases a token when the iframe unmounts.

use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::commands::db::PaDb;
use crate::commands::pkg::KernelState;
use crate::commands::secrets::{read_secret_scoped, Scope, SecretsLock};
use crate::pkg::permissions_check::{record_violation, ShellExecuteDenied};
use crate::pkg_content::PkgContentServer;

pub struct PkgContentState(pub Arc<PkgContentServer>);

#[derive(Serialize)]
pub struct PkgContentHandle {
    /// Fully-qualified URL ending in `/`. Append `<source>` (e.g. `index.html`)
    /// to get the iframe `src`.
    pub url: String,
    /// Per-iframe token. Pass back to `pkg_content_revoke` on unmount.
    pub token: String,
}

#[tauri::command]
pub fn pkg_content_url(
    server: State<'_, PkgContentState>,
    pkg_id: String,
) -> Result<PkgContentHandle, String> {
    let h = server.0.mint(&pkg_id).map_err(|e| format!("{e:#}"))?;
    Ok(PkgContentHandle {
        url: h.url,
        token: h.token,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupabaseHostConfig {
    pub url: String,
    pub anon_key: String,
}

/// Resolved SQLite host context threaded to pkgs that declared
/// `capabilities.sqlite` (ikenga_api ≥ 2). Exposes only the logical DB name
/// — actual queries go through the `db_query` Tauri command, not a client
/// library credential, so there is nothing secret to protect here.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqliteHostConfig {
    /// Logical DB name — currently always `"ikenga.local"` for the local
    /// `pa.db` store. Future: additional named stores may be added.
    pub db: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PkgContentHtmlHandle {
    /// HTML body with `<base href>` injected — assign to `<iframe srcdoc>`.
    pub html: String,
    /// Subresource base URL — exposed for diagnostics.
    pub base_url: String,
    /// Per-iframe token; pass back to `pkg_content_revoke` on unmount.
    pub token: String,
    /// Resolved Supabase config when the pkg declared
    /// `capabilities.supabase`. `None` if the pkg didn't declare it, or
    /// declared it as non-required and the vault is missing keys.
    pub supabase: Option<SupabaseHostConfig>,
    /// Resolved SQLite config when the pkg declared `capabilities.sqlite`.
    /// `None` if the pkg didn't declare the capability.
    pub sqlite: Option<SqliteHostConfig>,
    /// Resolved named secrets (ADR-017) when the pkg declared
    /// `capabilities.secrets` AND is trusted-for-elevated. `values` maps each
    /// declared `name` → its resolved plaintext; `missing` lists declared,
    /// non-required names absent from the vault (surfaced, non-fatal). `None`
    /// when the pkg didn't declare the cap or isn't trusted (fail-closed — the
    /// block is silently ignored for an untrusted pkg, exactly like an
    /// undeclared cap). The iframe only ever sees the resolved values, never a
    /// `vault_key`. Re-emitted on `host-context-changed` like Supabase.
    pub secrets: Option<SecretsHostConfig>,
}

/// Host-resolved named secrets threaded into `hostContext.secrets`. `values`
/// is `name → plaintext`; `missing` is the declared-but-absent (non-required)
/// names so the pkg can show "not configured" rather than silently failing.
/// Mirrors `HostSecretsConfig` in `shell/src/lib/pkg/host-context.ts`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretsHostConfig {
    pub values: std::collections::HashMap<String, String>,
    pub missing: Vec<String>,
}

/// Validate a resolved secret value against the declaration's `format` hint.
/// Only enforces the few well-known shapes; an unknown `format` is a no-op so
/// new format strings don't brick old manifests (matches the manifest comment).
fn validate_secret_format(name: &str, format: &Option<String>, value: &str) -> Result<(), String> {
    let Some(fmt) = format.as_deref() else {
        return Ok(());
    };
    let ok = match fmt {
        // A JWT is three base64url segments separated by dots.
        "jwt" => value.split('.').count() == 3 && !value.contains(char::is_whitespace),
        // A bearer token is any non-empty, whitespace-free opaque string.
        "bearer" => !value.is_empty() && !value.contains(char::is_whitespace),
        // Raw / unknown formats impose no shape.
        _ => true,
    };
    if ok {
        Ok(())
    } else {
        Err(format!(
            "capabilities.secrets[\"{name}\"]: resolved value does not match declared format `{fmt}`"
        ))
    }
}

/// Why named-secret resolution failed (the command translates each into the
/// right HTTP-ish outcome: audit+mount-error, mount-error, or mount-error).
#[derive(Debug)]
enum SecretResolveError {
    /// A declared `vault_key` isn't covered by any `permissions["vault.keys"]`
    /// glob — an authoring bug. The command audits this and fails the mount.
    OutOfScope { name: String, vault_key: String },
    /// A `required` secret has no value in the vault — fail the mount (Supabase
    /// `required` semantics).
    RequiredMissing { name: String, vault_key: String },
    /// A resolved value failed its declared `format` check.
    Format(String),
}

/// Pure named-secret resolver — the testable core of the injection path.
///
/// For each declaration: (1) require its `vault_key` ∈ `cap.vault_keys` globs
/// (else `OutOfScope`); (2) read the value via `read` (a closure so tests can
/// stub the vault); (3) a present, non-empty value is format-validated then
/// injected under its `name`; (4) an absent value is `RequiredMissing` when
/// `required`, else added to `missing`. No I/O, no trust — the caller has
/// already passed the trust gate and supplies the vault read.
fn resolve_named_secrets<F>(
    cap: &crate::pkg_content::SecretsCapabilityEntry,
    mut read: F,
) -> Result<SecretsHostConfig, SecretResolveError>
where
    F: FnMut(&str) -> Option<String>,
{
    use crate::commands::secrets::glob_match;
    let mut values = std::collections::HashMap::new();
    let mut missing = Vec::new();
    for decl in &cap.declarations {
        let in_scope = cap
            .vault_keys
            .iter()
            .any(|glob| glob_match(glob, &decl.vault_key));
        if !in_scope {
            return Err(SecretResolveError::OutOfScope {
                name: decl.name.clone(),
                vault_key: decl.vault_key.clone(),
            });
        }
        match read(&decl.vault_key) {
            Some(v) if !v.is_empty() => {
                validate_secret_format(&decl.name, &decl.format, &v)
                    .map_err(SecretResolveError::Format)?;
                values.insert(decl.name.clone(), v);
            }
            _ => {
                if decl.required {
                    return Err(SecretResolveError::RequiredMissing {
                        name: decl.name.clone(),
                        vault_key: decl.vault_key.clone(),
                    });
                }
                missing.push(decl.name.clone());
            }
        }
    }
    Ok(SecretsHostConfig { values, missing })
}

#[tauri::command]
pub async fn pkg_content_html(
    app: AppHandle,
    server: State<'_, PkgContentState>,
    secrets_lock: State<'_, SecretsLock>,
    kernel: State<'_, KernelState>,
    db: State<'_, Arc<PaDb>>,
    pkg_id: String,
    source: String,
) -> Result<PkgContentHtmlHandle, String> {
    let supabase = match server.0.supabase_capability(&pkg_id) {
        None => None,
        Some(required) => {
            // Phase 7: shared Supabase keys live at Workspace scope.
            // read_secret_scoped falls through to the legacy unscoped key
            // when the scoped row is missing — so user vaults populated
            // before Phase 7 keep working.
            let url =
                read_secret_scoped(&app, &secrets_lock, &Scope::Workspace, "VITE_SUPABASE_URL")
                    .unwrap_or_else(|e| {
                        log::warn!("[pkg_content] vault read VITE_SUPABASE_URL failed: {e}");
                        None
                    });
            let anon = read_secret_scoped(
                &app,
                &secrets_lock,
                &Scope::Workspace,
                "VITE_SUPABASE_ANON_KEY",
            )
            .unwrap_or_else(|e| {
                log::warn!("[pkg_content] vault read VITE_SUPABASE_ANON_KEY failed: {e}");
                None
            });
            match (url, anon) {
                (Some(u), Some(k)) if !u.is_empty() && !k.is_empty() => Some(SupabaseHostConfig {
                    url: u,
                    anon_key: k,
                }),
                _ => {
                    if required {
                        return Err(format!(
                            "pkg `{pkg_id}` requires supabase capability but vault is missing VITE_SUPABASE_URL and/or VITE_SUPABASE_ANON_KEY — open Settings → Secrets to populate them"
                        ));
                    }
                    None
                }
            }
        }
    };
    let sqlite = server
        .0
        .sqlite_capability(&pkg_id)
        .map(|db| SqliteHostConfig { db });

    // Named-secret injection (ADR-017) — generalizes the Supabase precedent
    // above into a declared `capabilities.secrets`. TRUSTED pkgs only. The
    // shell resolves each declared `vault_key` from Stronghold (Workspace
    // scope, mirroring Supabase) and injects only the resolved *value* into
    // `hostContext.secrets[name]` — the `vault_key` never reaches the iframe.
    let secrets = match server.0.secrets_capability(&pkg_id) {
        None => None,
        Some(cap) => {
            // Trust gate — AutoTrusted-only (builtin / dev / signed-registry).
            // Fail-closed: an untrusted pkg's secrets block is silently ignored,
            // exactly as if it had never declared the capability.
            use tauri::Manager;
            let app_data = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("app_data_dir: {e}"))?;
            let pool = db.ensure_pool().await.map_err(|e| e.to_string())?;
            let trusted = crate::pkg::trust::resolve_elevated_trust(
                &pool, &kernel.0, &app_data, &pkg_id,
            )
            .await;
            if !trusted {
                tracing::warn!(
                    "[pkg_content] pkg `{pkg_id}` declares capabilities.secrets but is not \
                     trusted-for-elevated — injection skipped (fail-closed). Elevated caps \
                     require builtin provenance or a signed-registry signature."
                );
                None
            } else {
                // Resolve at Workspace scope (matches the Supabase path; the
                // project-scoped read path is deferred — see design open Qs).
                // The pure resolver does the vault.keys scope-check, the
                // value/missing/required split, and format validation; we only
                // do the async vault read + audit here.
                match resolve_named_secrets(&cap, |vault_key| {
                    read_secret_scoped(&app, &secrets_lock, &Scope::Workspace, vault_key)
                        .unwrap_or_else(|e| {
                            tracing::warn!(
                                "[pkg_content] pkg `{pkg_id}` vault read `{vault_key}` failed: {e}"
                            );
                            None
                        })
                }) {
                    Ok(cfg) => {
                        tracing::info!(
                            "[pkg_content] pkg `{pkg_id}` injected {} secret(s) ({} missing)",
                            cfg.values.len(),
                            cfg.missing.len()
                        );
                        Some(cfg)
                    }
                    Err(SecretResolveError::OutOfScope { name, vault_key }) => {
                        // Authoring bug → audit to pkg_permission_violations so
                        // the denial is visible in the Settings audit view, then
                        // hard-fail the mount.
                        record_violation(
                            &pool,
                            "capabilities.secrets",
                            &ShellExecuteDenied {
                                pkg_id: pkg_id.clone(),
                                command: vault_key.clone(),
                                declared: cap.vault_keys.join(","),
                            },
                        )
                        .await
                        .ok();
                        return Err(format!(
                            "pkg `{pkg_id}` capabilities.secrets[\"{name}\"]: vault_key \
                             `{vault_key}` is not covered by any permissions[\"vault.keys\"] pattern"
                        ));
                    }
                    Err(SecretResolveError::RequiredMissing { name, vault_key }) => {
                        return Err(format!(
                            "pkg `{pkg_id}` requires secret `{name}` (vault_key `{vault_key}`) but \
                             the vault has no value — open Settings → Secrets to populate it"
                        ));
                    }
                    Err(SecretResolveError::Format(msg)) => return Err(msg),
                }
            }
        }
    };

    let h = server
        .0
        .mint_html(&pkg_id, &source)
        .map_err(|e| format!("{e:#}"))?;
    Ok(PkgContentHtmlHandle {
        html: h.html,
        base_url: h.base_url,
        token: h.token,
        supabase,
        sqlite,
        secrets,
    })
}

#[tauri::command]
pub fn pkg_content_revoke(server: State<'_, PkgContentState>, token: String) -> Result<(), String> {
    server.0.revoke(&token);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pkg_content::{NamedSecretDecl, SecretsCapabilityEntry};
    use std::collections::HashMap;

    fn decl(name: &str, vault_key: &str, required: bool, format: Option<&str>) -> NamedSecretDecl {
        NamedSecretDecl {
            name: name.into(),
            vault_key: vault_key.into(),
            required,
            format: format.map(|s| s.into()),
        }
    }

    fn cap(decls: Vec<NamedSecretDecl>, vault_keys: &[&str]) -> SecretsCapabilityEntry {
        SecretsCapabilityEntry {
            declarations: decls,
            vault_keys: vault_keys.iter().map(|s| s.to_string()).collect(),
        }
    }

    /// A vault stub that knows a fixed set of key→value pairs.
    fn vault(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    /// Trusted pkg (the trust gate is upstream; this exercises the resolver
    /// the command runs *after* the gate passes): an in-scope, present key is
    /// injected under its logical name; the vault_key never appears in output.
    #[test]
    fn trusted_pkg_gets_resolved_values_keyed_by_name() {
        let c = cap(
            vec![decl("TWENTY_API_KEY", "TWENTY_API_KEY", false, None)],
            &["TWENTY_*"],
        );
        let v = vault(&[("TWENTY_API_KEY", "twk-secret")]);
        let out = resolve_named_secrets(&c, |k| v.get(k).cloned()).expect("resolves");
        assert_eq!(out.values.get("TWENTY_API_KEY").map(String::as_str), Some("twk-secret"));
        assert!(out.missing.is_empty());
    }

    /// Out-of-`vault.keys`-scope key is rejected (authoring bug). This is the
    /// fail-closed scope gate: even a present vault value is refused if the
    /// declared vault_key isn't covered by a permissions["vault.keys"] glob.
    #[test]
    fn out_of_vault_keys_scope_is_rejected() {
        let c = cap(
            vec![decl("STRIPE", "STRIPE_SECRET_KEY", false, None)],
            &["TWENTY_*", "RESEND_*"], // STRIPE_SECRET_KEY matches NEITHER
        );
        let v = vault(&[("STRIPE_SECRET_KEY", "sk_live_leak")]);
        let err = resolve_named_secrets(&c, |k| v.get(k).cloned()).unwrap_err();
        match err {
            SecretResolveError::OutOfScope { name, vault_key } => {
                assert_eq!(name, "STRIPE");
                assert_eq!(vault_key, "STRIPE_SECRET_KEY");
            }
            other => panic!("expected OutOfScope, got {other:?}"),
        }
    }

    /// A `required` secret that's absent from the vault fails the mount
    /// (Supabase `required` semantics).
    #[test]
    fn required_missing_errors() {
        let c = cap(
            vec![decl("RESEND_API_KEY", "RESEND_API_KEY", true, None)],
            &["RESEND_*"],
        );
        let err = resolve_named_secrets(&c, |_| None).unwrap_err();
        assert!(matches!(err, SecretResolveError::RequiredMissing { .. }), "{err:?}");
    }

    /// An optional secret that's absent surfaces in `missing` (non-fatal), not
    /// in `values` — the pkg can show "not configured".
    #[test]
    fn optional_missing_is_surfaced_not_fatal() {
        let c = cap(
            vec![
                decl("PRESENT", "A_KEY", false, None),
                decl("ABSENT", "B_KEY", false, None),
            ],
            &["*"],
        );
        let v = vault(&[("A_KEY", "yes")]);
        let out = resolve_named_secrets(&c, |k| v.get(k).cloned()).expect("resolves");
        assert_eq!(out.values.get("PRESENT").map(String::as_str), Some("yes"));
        assert_eq!(out.missing, vec!["ABSENT".to_string()]);
        assert!(!out.values.contains_key("ABSENT"));
    }

    /// An empty-string vault value is treated as missing (matches the Supabase
    /// `!v.is_empty()` precedent).
    #[test]
    fn empty_value_counts_as_missing() {
        let c = cap(vec![decl("K", "K", false, None)], &["K"]);
        let v = vault(&[("K", "")]);
        let out = resolve_named_secrets(&c, |k| v.get(k).cloned()).expect("resolves");
        assert!(out.values.is_empty());
        assert_eq!(out.missing, vec!["K".to_string()]);
    }

    /// Format hint enforcement: a non-JWT value for a `format:"jwt"` decl fails.
    #[test]
    fn format_jwt_rejects_non_jwt() {
        let c = cap(vec![decl("J", "J_KEY", false, Some("jwt"))], &["J_KEY"]);
        let v = vault(&[("J_KEY", "not-a-jwt")]);
        let err = resolve_named_secrets(&c, |k| v.get(k).cloned()).unwrap_err();
        assert!(matches!(err, SecretResolveError::Format(_)), "{err:?}");
    }

    #[test]
    fn format_jwt_accepts_three_segment_value() {
        let c = cap(vec![decl("J", "J_KEY", false, Some("jwt"))], &["J_KEY"]);
        let v = vault(&[("J_KEY", "aaa.bbb.ccc")]);
        let out = resolve_named_secrets(&c, |k| v.get(k).cloned()).expect("resolves");
        assert_eq!(out.values.get("J").map(String::as_str), Some("aaa.bbb.ccc"));
    }

    /// An unknown format string is a no-op (forward-compat — old shells don't
    /// brick on a new format).
    #[test]
    fn unknown_format_is_a_noop() {
        let c = cap(vec![decl("K", "K", false, Some("future-fmt"))], &["K"]);
        let v = vault(&[("K", "anything goes")]);
        let out = resolve_named_secrets(&c, |k| v.get(k).cloned()).expect("resolves");
        assert_eq!(out.values.get("K").map(String::as_str), Some("anything goes"));
    }

    #[test]
    fn validate_secret_format_none_is_ok() {
        assert!(validate_secret_format("n", &None, "whatever").is_ok());
    }
}
