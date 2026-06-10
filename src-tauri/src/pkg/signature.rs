//! Manifest signature verification (ADR-017 / trusted-pkg WP-02).
//!
//! A registry-published pkg may carry a top-level `signature` (a minisign
//! `.minisig` blob) over the **canonical** bytes of its own manifest. The
//! signed registry index (verified FE-side, `lib/registry/client.ts`) names a
//! `publisher_key` for the pkg; that key flows into
//! `InstallSource::Registry.publisher_key`. At install and at every boot
//! replay we re-derive the canonical bytes and check the signature against
//! that key. A pkg whose signature verifies is eligible for *elevated*
//! capabilities (`is_trusted_for_elevated`), same ceiling as a builtin; an
//! unsigned or failed-signature registry pkg still installs and runs, it
//! simply isn't trusted for elevated caps.
//!
//! ## Why minisign (not a hand-rolled ed25519)
//!
//! The shell already verifies the registry *index* with minisign
//! (`@ikenga/registry-client::verifyMinisign` + `REGISTRY_PUBKEY`). Verifying
//! manifests with the same scheme keeps **one** signature primitive across the
//! whole trust chain — no second crypto dependency, no second key format. The
//! `minisign-verify` crate is already in `Cargo.lock` (transitively via
//! `tauri-plugin-updater`); WP-02 pins it as a direct dep at the same version.
//! minisign is Ed25519 over a BLAKE2b prehash, so ADR-017's "ed25519" intent
//! holds.
//!
//! ## Fail-closed
//!
//! Every non-success path — missing key, missing signature, malformed blob,
//! bad bytes — yields a verdict that is **not** `Valid`. The trust gate treats
//! anything other than `Valid` as "no elevated caps". A verification *error*
//! never silently grants trust.
//!
//! # CANONICAL MANIFEST JSON v1 — WP-06 signer MUST match this
//!
//! The bytes that are signed/verified are produced from the manifest by this
//! exact, simple, documented algorithm. The signing pipeline (WP-06) MUST
//! reproduce these bytes byte-for-byte or every signed manifest fails to
//! verify and silently drops to untrusted. The shared golden vector in
//! `testdata/signature_golden_v1/` is the regression anchor for both sides.
//!
//! 1. Parse the manifest JSON into a generic JSON value (`serde_json::Value`).
//! 2. **Remove the top-level `signature` field** (a signature cannot sign over
//!    itself). Removal is unconditional — present or absent, the result has no
//!    `signature` key.
//! 3. **Recursively sort every object's keys** in ascending byte order of the
//!    UTF-8 key string. (`serde_json::Value`'s object map is a `BTreeMap` when
//!    the `preserve_order` feature is off — which it is here — so re-serializing
//!    a `Value` already emits keys sorted; the recursive rebuild below makes the
//!    guarantee explicit and feature-independent.)
//! 4. **Serialize compact**: no insignificant whitespace, `,` and `:`
//!    separators only (serde_json's default `to_vec`, never `to_vec_pretty`).
//! 5. **UTF-8** output, **standard JSON string escaping** (serde_json's default:
//!    `"`, `\`, and the C0 control chars are escaped; non-ASCII is emitted as
//!    raw UTF-8 bytes, not `\u` escapes). **No trailing newline.**
//!
//! Array element order is preserved (arrays are ordered data). Manifests
//! contain only strings, bools, integers, arrays, and objects — **no floats** —
//! so there is no float-formatting ambiguity to canonicalize away; full
//! RFC 8785 (JCS) number canonicalization is unnecessary and intentionally not
//! used (no JCS crate is in the tree, and sorted-compact is sufficient for this
//! value space).
//!
//! Reference generator (used to build the golden vector; equivalent to the Rust
//! below):
//! ```text
//! python3 -c '
//! import json,sys
//! o=json.load(open("manifest.json")); o.pop("signature",None)
//! sys.stdout.buffer.write(
//!   json.dumps(o,sort_keys=True,separators=(",",":"),ensure_ascii=False).encode())'
//! ```

use std::path::Path;

use serde_json::Value;

use crate::pkg::manifest::Package;
use crate::pkg::source::InstallSource;

/// Outcome of verifying a manifest's signature against an install source.
///
/// Only `Valid` grants elevated-cap eligibility. Every other variant is
/// fail-closed: the pkg installs and runs, but `is_trusted_for_elevated`
/// stays false.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SignatureVerdict {
    /// The manifest's signature verified against `publisher_key`. The pkg is
    /// eligible for elevated capabilities (subject to the existing
    /// sensitive-perms snapshot, same as a builtin).
    Valid,
    /// Source is not a registry install (Builtin / Local / Dev). Signature
    /// verification doesn't apply; trust comes from provenance, not crypto.
    /// (Builtin reaches elevated via the trust gate's own builtin arm; Dev via
    /// its bypass — *not* via this verdict.)
    NotApplicable,
    /// Registry source with no `signature` field. Legal — the pkg is simply not
    /// trusted for elevated caps. The common case for community pkgs.
    Unsigned,
    /// Registry source carries a `signature` but the index named no
    /// `publisher_key` for it. Fail-closed: we cannot establish who vouched for
    /// the key, so the signature is worthless.
    MissingPublisherKey,
    /// Verification was attempted and failed: tampered bytes, wrong key,
    /// malformed key, or malformed signature blob. Fail-closed. `reason` is a
    /// short human label for logs/audit — never a trust decision input.
    Invalid { reason: String },
}

impl SignatureVerdict {
    /// True only for `Valid`. This is the single bit the trust gate consumes.
    pub fn is_valid(&self) -> bool {
        matches!(self, SignatureVerdict::Valid)
    }

    /// Short stable label for structured logging / the audit trail.
    pub fn label(&self) -> &'static str {
        match self {
            SignatureVerdict::Valid => "valid",
            SignatureVerdict::NotApplicable => "not_applicable",
            SignatureVerdict::Unsigned => "unsigned",
            SignatureVerdict::MissingPublisherKey => "missing_publisher_key",
            SignatureVerdict::Invalid { .. } => "invalid",
        }
    }
}

/// Produce the CANONICAL MANIFEST JSON v1 bytes for a manifest, given its JSON
/// value. See the module doc-comment for the authoritative algorithm. The
/// `signature` field is stripped here, so callers may pass the value with or
/// without it.
///
/// Errors only if the canonical value fails to serialize, which for a value
/// that already parsed from JSON cannot happen in practice.
pub fn canonical_manifest_bytes(manifest_value: &Value) -> Result<Vec<u8>, serde_json::Error> {
    let canon = canonicalize_value(manifest_value, /* is_root = */ true);
    serde_json::to_vec(&canon)
}

/// Convenience: canonicalize directly from the manifest JSON text (as read from
/// `manifest.json` on disk). Parses, then delegates to `canonical_manifest_bytes`.
pub fn canonical_manifest_bytes_from_str(manifest_json: &str) -> Result<Vec<u8>, serde_json::Error> {
    let v: Value = serde_json::from_str(manifest_json)?;
    canonical_manifest_bytes(&v)
}

/// Recursively rebuild a JSON value with sorted object keys, stripping the
/// top-level `signature` field. `serde_json::Map` is a `BTreeMap` here
/// (no `preserve_order` feature), so collecting into a fresh map yields sorted
/// keys; the explicit recursion makes the sort guarantee independent of that
/// feature flag and applies it at every depth.
fn canonicalize_value(v: &Value, is_root: bool) -> Value {
    match v {
        Value::Object(map) => {
            let mut out = serde_json::Map::new();
            for (k, val) in map {
                if is_root && k == "signature" {
                    continue; // a signature can't sign over itself
                }
                out.insert(k.clone(), canonicalize_value(val, /* is_root = */ false));
            }
            Value::Object(out)
        }
        Value::Array(items) => {
            Value::Array(items.iter().map(|x| canonicalize_value(x, false)).collect())
        }
        // Scalars (string / bool / number / null) are emitted verbatim. Manifest
        // numbers are integers only (no floats), so serde_json's integer
        // formatting is already canonical for this value space.
        other => other.clone(),
    }
}

/// Verify a manifest signature blob against a publisher key over canonical bytes.
///
/// - `canonical`: the CANONICAL MANIFEST JSON v1 bytes (from
///   `canonical_manifest_bytes`).
/// - `signature_blob`: the manifest's `signature` field — a full minisign
///   `.minisig` blob (4 lines: untrusted comment, data sig, trusted comment,
///   global sig). This is exactly what `minisign -S` writes and what the FE's
///   index verifier consumes for the index.
/// - `publisher_key`: the minisign public key. Accepts either the bare base64
///   payload line or the 2-line `.pub` form (with the `untrusted comment:`
///   header) — both are what the signed index / `.pub` file carry.
///
/// Returns `Valid` only on a clean verify; every failure mode is a distinct
/// fail-closed `Invalid { reason }`.
pub fn verify_signature_blob(
    canonical: &[u8],
    signature_blob: &str,
    publisher_key: &str,
) -> SignatureVerdict {
    use minisign_verify::{PublicKey, Signature};

    // The index/`.pub` may carry the key as a bare base64 line or the 2-line
    // `.pub` file (untrusted comment + key). `from_base64` wants just the
    // payload line; `decode` wants the 2-line form. Try the cheaper bare form
    // first, fall back to the commented form.
    let pk = match PublicKey::from_base64(publisher_key.trim()) {
        Ok(pk) => pk,
        Err(_) => match PublicKey::decode(publisher_key) {
            Ok(pk) => pk,
            Err(e) => {
                return SignatureVerdict::Invalid {
                    reason: format!("malformed publisher key: {e}"),
                };
            }
        },
    };

    let sig = match Signature::decode(signature_blob) {
        Ok(s) => s,
        Err(e) => {
            return SignatureVerdict::Invalid {
                reason: format!("malformed signature blob: {e}"),
            };
        }
    };

    // `allow_legacy = false`: require the prehashed (BLAKE2b) form that modern
    // `minisign -S` emits by default. A legacy-mode signature is rejected,
    // which is fine — WP-06 signs with a current minisign.
    match pk.verify(canonical, &sig, /* allow_legacy = */ false) {
        Ok(()) => SignatureVerdict::Valid,
        Err(e) => SignatureVerdict::Invalid {
            reason: format!("signature did not verify: {e}"),
        },
    }
}

/// Verify an installed pkg's manifest signature against its install source.
///
/// This is the seam the kernel calls at `install_from_path` (after
/// `Package::load`) and at boot replay. It dispatches on provenance:
///
/// - **Builtin / Local / Dev** → `NotApplicable` (provenance trust, no crypto).
/// - **Registry without `signature`** → `Unsigned` (legal; just not elevated).
/// - **Registry with `signature` but no `publisher_key` in the source** →
///   `MissingPublisherKey` (fail-closed: the index didn't vouch for a key).
/// - **Registry with both** → minisign-verify the manifest's canonical bytes.
///
/// The canonical bytes are derived from the **raw `manifest.json` on disk**,
/// not the re-serialized `Manifest` struct, so verification is faithful to the
/// exact bytes the signer (WP-06) canonicalized — independent of any
/// struct/serde round-trip differences (defaulted fields, field renames). If
/// the on-disk file can't be read/parsed we fail closed (`Invalid`); the kernel
/// already loaded the manifest via `Package::load`, so a read failure here is an
/// anomaly, not the normal path.
pub fn verify_manifest_signature(pkg: &Package, source: &InstallSource) -> SignatureVerdict {
    // Provenance trust: only registry installs are signature-gated.
    let publisher_key = match source {
        InstallSource::Registry { publisher_key, .. } => publisher_key.as_deref(),
        // Builtin/Local/Dev: trust (or lack of it) is decided by provenance in
        // trust.rs, not by a signature.
        _ => return SignatureVerdict::NotApplicable,
    };

    let Some(signature_blob) = pkg.manifest.signature.as_deref() else {
        // Registry pkg with no signature — runs, simply not trusted-for-elevated.
        return SignatureVerdict::Unsigned;
    };

    let Some(publisher_key) = publisher_key else {
        // Signed manifest but the signed index named no key for it. We cannot
        // establish who vouched for the signer → the signature is worthless.
        return SignatureVerdict::MissingPublisherKey;
    };

    let canonical = match read_canonical_from_disk(&pkg.install_path) {
        Ok(bytes) => bytes,
        Err(reason) => return SignatureVerdict::Invalid { reason },
    };

    verify_signature_blob(&canonical, signature_blob, publisher_key)
}

/// Read `<install_path>/manifest.json` and produce its canonical bytes. Reading
/// the raw file (rather than re-serializing the parsed `Manifest`) guarantees
/// we canonicalize the same bytes the signer did.
fn read_canonical_from_disk(install_path: &Path) -> Result<Vec<u8>, String> {
    let manifest_path = install_path.join("manifest.json");
    let raw = std::fs::read_to_string(&manifest_path)
        .map_err(|e| format!("read {} for signature check: {e}", manifest_path.display()))?;
    canonical_manifest_bytes_from_str(&raw)
        .map_err(|e| format!("canonicalize manifest for signature check: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    // The golden vector — THE contract WP-06 reuses. Embedded at compile time so
    // the verifier tests against the exact artifacts the signer must reproduce.
    const GOLDEN_MANIFEST: &str =
        include_str!("testdata/signature_golden_v1/manifest.json");
    const GOLDEN_CANONICAL: &str =
        include_str!("testdata/signature_golden_v1/canonical.json");
    const GOLDEN_PUBKEY: &str = include_str!("testdata/signature_golden_v1/publisher.pub");
    const GOLDEN_SIG: &str = include_str!("testdata/signature_golden_v1/manifest.minisig");

    /// The canonicalizer reproduces the committed golden canonical bytes
    /// EXACTLY. If this fails after a canonicalization change, the golden
    /// vector (and WP-06) must be regenerated in lockstep.
    #[test]
    fn canonicalization_matches_golden_bytes() {
        let produced = canonical_manifest_bytes_from_str(GOLDEN_MANIFEST).expect("canonicalize");
        assert_eq!(
            String::from_utf8(produced.clone()).unwrap(),
            GOLDEN_CANONICAL,
            "canonical bytes drifted from the golden vector — WP-06 contract broken"
        );
        // Belt-and-suspenders: no trailing newline, exact byte length.
        assert_eq!(produced.len(), GOLDEN_CANONICAL.as_bytes().len());
        assert!(!produced.ends_with(b"\n"));
    }

    /// Canonicalization is deterministic regardless of source key order: the
    /// same manifest with its keys shuffled produces identical canonical bytes.
    #[test]
    fn canonicalization_is_key_order_independent() {
        let shuffled = r#"{
            "version":"1.2.3",
            "signature":"ANYTHING-DIFFERENT",
            "name":"Signed Example",
            "ikenga_api":"3",
            "id":"com.example.signed",
            "capabilities":{"http":{"endpoints":[{"urlPattern":"https://api.example.com/*","authSecret":"EXAMPLE_API_KEY"}],"required":false}},
            "permissions":{"vault.keys":["EXAMPLE_API_KEY"],"shell.execute":[],"net":["https://api.example.com/"],"fs.write":[],"fs.read":[]}
        }"#;
        let a = canonical_manifest_bytes_from_str(GOLDEN_MANIFEST).unwrap();
        let b = canonical_manifest_bytes_from_str(shuffled).unwrap();
        assert_eq!(a, b, "key order / signature value must not affect canonical bytes");
    }

    /// THE critical security test: a valid signature over the golden canonical
    /// bytes verifies; flipping a single byte AFTER signing makes it fail.
    #[test]
    fn forged_manifest_fails_verification() {
        // Clean: golden canonical bytes verify against the golden key + sig.
        let verdict = verify_signature_blob(GOLDEN_CANONICAL.as_bytes(), GOLDEN_SIG, GOLDEN_PUBKEY);
        assert_eq!(verdict, SignatureVerdict::Valid, "clean golden vector must verify");

        // Forged: flip one byte of the signed content. Must NOT verify.
        let mut tampered = GOLDEN_CANONICAL.as_bytes().to_vec();
        tampered[0] ^= 0x01;
        let forged = verify_signature_blob(&tampered, GOLDEN_SIG, GOLDEN_PUBKEY);
        assert!(
            !forged.is_valid(),
            "tampered content must fail — got {forged:?}"
        );
        assert!(matches!(forged, SignatureVerdict::Invalid { .. }));
    }

    /// Full path: canonicalize the golden manifest ourselves, then verify the
    /// golden signature against OUR canonical bytes. Proves the verifier consumes
    /// exactly what the canonicalizer produces (the WP-06 round-trip).
    #[test]
    fn end_to_end_canonicalize_then_verify() {
        let canonical = canonical_manifest_bytes_from_str(GOLDEN_MANIFEST).unwrap();
        let verdict = verify_signature_blob(&canonical, GOLDEN_SIG, GOLDEN_PUBKEY);
        assert_eq!(verdict, SignatureVerdict::Valid);
    }

    /// A different (wrong) publisher key must not verify the golden signature.
    /// Uses the minisign-verify crate's own doc-test public key (a real, valid
    /// minisign key that simply didn't sign our content).
    #[test]
    fn wrong_publisher_key_fails() {
        const OTHER_KEY: &str = "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
        let verdict = verify_signature_blob(GOLDEN_CANONICAL.as_bytes(), GOLDEN_SIG, OTHER_KEY);
        assert!(!verdict.is_valid(), "wrong key must fail — got {verdict:?}");
    }

    /// The publisher key is accepted in BOTH the bare-base64 form and the 2-line
    /// `.pub` form. The golden `publisher.pub` is the 2-line form; the bare
    /// payload line is what the index carries.
    #[test]
    fn publisher_key_accepts_bare_and_commented_forms() {
        // 2-line form (the committed `.pub`).
        let v1 = verify_signature_blob(GOLDEN_CANONICAL.as_bytes(), GOLDEN_SIG, GOLDEN_PUBKEY);
        assert_eq!(v1, SignatureVerdict::Valid);

        // Bare payload line (last non-comment line of the `.pub`).
        let bare = GOLDEN_PUBKEY
            .lines()
            .find(|l| !l.is_empty() && !l.starts_with("untrusted comment:"))
            .unwrap();
        let v2 = verify_signature_blob(GOLDEN_CANONICAL.as_bytes(), GOLDEN_SIG, bare);
        assert_eq!(v2, SignatureVerdict::Valid);
    }

    /// A malformed signature blob is fail-closed (Invalid, not a panic).
    #[test]
    fn malformed_signature_blob_is_invalid() {
        let verdict = verify_signature_blob(GOLDEN_CANONICAL.as_bytes(), "not a minisig", GOLDEN_PUBKEY);
        assert!(matches!(verdict, SignatureVerdict::Invalid { .. }));
    }

    /// A malformed publisher key is fail-closed (Invalid, not a panic).
    #[test]
    fn malformed_publisher_key_is_invalid() {
        let verdict = verify_signature_blob(GOLDEN_CANONICAL.as_bytes(), GOLDEN_SIG, "@@not-base64@@");
        assert!(matches!(verdict, SignatureVerdict::Invalid { .. }));
    }
}
