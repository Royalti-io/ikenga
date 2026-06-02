---
"ikenga-desktop": patch
---

Slim install size: stop bundling the ~89 MB Bun runtime in release artifacts (deb/AppImage/dmg/nsis) and resolve it at runtime instead (env `IKENGA_BUN_PATH` → version-gated system `bun` ≥ 1.3.14 → cached fetched bun with SHA-pin → post-launch background fetch with a progress chip; sha256-verified before unzip, no-strike park while fetching). Add `[profile.release]` strip + thin LTO so the binary itself is smaller across every target. The app boots and runs without bun; only bun-backed sidecars wait for the background fetch. Offline/air-gapped installs documented (system bun, drop-in binary, `IKENGA_BUN_PATH`).
