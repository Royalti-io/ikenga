# Golden signature vector v1 — the WP-02 ↔ WP-06 contract

This directory is **the** byte-for-byte contract between the manifest verifier
(WP-02, `pkg/signature.rs`) and the signing pipeline (WP-06, `ikenga-pkgs`).
WP-06's signer MUST reproduce `canonical.json` byte-for-byte from `manifest.json`
and MUST sign it with `minisign` such that `manifest.minisig` verifies against
`publisher.pub`.

## Files

| File | What it is |
|---|---|
| `manifest.json` | A fully-populated fixture manifest. Carries a `"signature"` field with a throwaway placeholder string (stripped before canonicalization — it can be anything). |
| `canonical.json` | The **CANONICAL MANIFEST JSON v1** bytes of `manifest.json` — i.e. the exact bytes that were signed. Recursively sorted keys, compact separators, `signature` field removed. No trailing newline. 347 bytes. |
| `publisher.pub` | The minisign public key (2-line `.pub` format). The base64 payload line is what goes into `InstallSource::Registry.publisher_key`. |
| `manifest.minisig` | The minisign signature blob (4-line `.minisig`) over `canonical.json`. This whole blob is what goes into the manifest's top-level `signature` string field. |

## How it was generated (reproducible, mirrors WP-06's CI)

```bash
# 1. canonicalize (strip `signature`, sort keys recursively, compact)
#    — see CANONICAL MANIFEST JSON v1 in pkg/signature.rs for the exact algorithm
python3 -c "..."  > canonical.json     # see signature.rs doc-comment

# 2. one-time keypair (WP-06 uses the real release key instead)
minisign -G -W -p publisher.pub -s publisher.key

# 3. sign the CANONICAL bytes (not the raw manifest, not the tarball)
minisign -S -s publisher.key -m canonical.json -x manifest.minisig
```

## What WP-06 must match

1. Produce `canonical.json` from a real manifest using the **same** canonicalization
   (the doc-comment "CANONICAL MANIFEST JSON v1" in `pkg/signature.rs` is authoritative).
2. Sign those canonical bytes with `minisign -S` (default prehashed/BLAKE2b mode).
3. Store the **whole `.minisig` blob** (all 4 lines) in `manifest.json`'s top-level
   `signature` field.
4. Record the **base64 payload line** of the publisher `.pub` in the signed registry
   index entry, which the shell threads into `InstallSource::Registry.publisher_key`.

If WP-06 changes the canonicalization by even one byte, every notarized pkg
silently fails verification and drops to untrusted. Treat any drift as a release
blocker — re-run the `golden_vector_*` tests in `pkg/signature.rs`.
