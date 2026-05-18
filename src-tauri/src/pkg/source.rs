//! Provenance for an installed package.
//!
//! `InstallSource` records *where* a package came from, which downstream code
//! uses to decide trust, update channels, and uninstall policy. Stored on
//! `pkg_installed.source_json` and surfaced on `InstalledSummary` so the UI and
//! external tools see the same shape.
//!
//! Wire format is `{"kind": "...", ...}` — stable for the FE TS contract.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum InstallSource {
    /// Shipped with the shell bundle (resources/builtin-pkgs/). The kernel
    /// refuses to uninstall these.
    Builtin,
    /// Installed from a registry — the official Royalti registry today, a
    /// future marketplace tomorrow. `publisher_key` is the ed25519 public key
    /// that signed the manifest, when known.
    Registry {
        url: String,
        #[serde(default)]
        publisher_key: Option<String>,
    },
    /// Installed from a local directory (dev workspace, sideload). The path is
    /// retained so the manifest origin is still traceable even if the install
    /// dir later moves.
    Local { path: String },
    /// Symlinked from a developer workspace via `ikenga dev <path>`. Like
    /// `Local` but also opted into hot-reload semantics: the kernel watches
    /// `manifest.json` + every `restart_when_changed` glob, the trust gate
    /// auto-trusts (regardless of pkg id namespace), and the FE listens for
    /// `pkg-reloaded` events to remount mounted iframes.
    ///
    /// `path` is the developer's source dir — the same value the CLI passes
    /// to `pkg_dev_register`. Dev pkgs are removed on shell shutdown / by
    /// `pkg_dev_unregister`; they never persist as `Dev` across reboot.
    Dev { path: String },
}

impl InstallSource {
    pub fn is_builtin(&self) -> bool {
        matches!(self, InstallSource::Builtin)
    }

    pub fn is_dev(&self) -> bool {
        matches!(self, InstallSource::Dev { .. })
    }

    /// Parse a stored `source_json` blob, falling back to `Local { path }`
    /// when the value is missing or unparseable. Used at boot for rows that
    /// predate the source column.
    pub fn parse_or_local(raw: Option<&str>, install_path: &str) -> Self {
        match raw {
            Some(s) if !s.trim().is_empty() => {
                serde_json::from_str(s).unwrap_or_else(|_| InstallSource::Local {
                    path: install_path.to_string(),
                })
            }
            _ => InstallSource::Local {
                path: install_path.to_string(),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_builtin_with_kind_tag() {
        let s = serde_json::to_string(&InstallSource::Builtin).unwrap();
        assert_eq!(s, r#"{"kind":"builtin"}"#);
    }

    #[test]
    fn serializes_registry_with_optional_publisher_key() {
        let with_key = serde_json::to_string(&InstallSource::Registry {
            url: "https://reg.example/r".into(),
            publisher_key: Some("ed25519:abc".into()),
        })
        .unwrap();
        assert!(with_key.contains(r#""kind":"registry""#));
        assert!(with_key.contains(r#""publisher_key":"ed25519:abc""#));

        let without_key: InstallSource =
            serde_json::from_str(r#"{"kind":"registry","url":"u"}"#).unwrap();
        assert_eq!(
            without_key,
            InstallSource::Registry {
                url: "u".into(),
                publisher_key: None,
            }
        );
    }

    #[test]
    fn serializes_dev_with_path() {
        let s = serde_json::to_string(&InstallSource::Dev {
            path: "/home/me/code/my-pkg".into(),
        })
        .unwrap();
        assert!(s.contains(r#""kind":"dev""#));
        assert!(s.contains(r#""path":"/home/me/code/my-pkg""#));

        let round_trip: InstallSource =
            serde_json::from_str(r#"{"kind":"dev","path":"/x"}"#).unwrap();
        assert_eq!(round_trip, InstallSource::Dev { path: "/x".into() });
        assert!(round_trip.is_dev());
        assert!(!round_trip.is_builtin());
    }

    #[test]
    fn parse_or_local_handles_missing_and_garbage() {
        let from_none = InstallSource::parse_or_local(None, "/tmp/x");
        assert_eq!(
            from_none,
            InstallSource::Local {
                path: "/tmp/x".into()
            }
        );
        let from_garbage = InstallSource::parse_or_local(Some("not json"), "/tmp/x");
        assert_eq!(
            from_garbage,
            InstallSource::Local {
                path: "/tmp/x".into()
            }
        );
        let from_valid = InstallSource::parse_or_local(Some(r#"{"kind":"builtin"}"#), "/tmp/x");
        assert_eq!(from_valid, InstallSource::Builtin);
    }
}
