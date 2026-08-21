---
"ikenga-desktop": patch
---

Point the registry and primitives catalog at `registry.ikenga.dev` instead of the
GitHub-hosted `royalti-io.github.io` URL. Same content, same signing key — a
hostname we own, so the registry no longer depends on which GitHub org holds the
repo. Kept in lockstep with `@ikenga/cli`.
