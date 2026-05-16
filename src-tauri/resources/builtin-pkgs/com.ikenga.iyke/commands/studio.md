---
description: Open the unified Artifact Studio at grid, loupe, or compare density.
argument-hint: <path> [vs <other>] [density grid|loupe|compare]
---

The **unified Artifact Studio** is a single pane type (`artifact-studio`) with three densities:

- **`grid`** — folder rendered as a Lightroom-style contact-sheet of artifact thumbnails. Default when `path` is a directory.
- **`loupe`** — single artifact with preview + version strip + right rail (Chat / Code / DOM / Manifest tabs). Default when `path` is a file.
- **`compare`** — two artifacts side-by-side with per-side "make canonical" actions. Requires `vs <other-path>`.

Use the `iyke_open` tool with `kind: "artifact-studio"` and:

- **Just a folder** → `{ kind: "artifact-studio", path: "<folder>" }` — the FE picks `grid` density by default.
- **Just a file** → `{ kind: "artifact-studio", path: "<file>" }` — the FE picks `loupe` density by default.
- **Explicit density** → `{ kind: "artifact-studio", path: "...", density: "grid|loupe|compare" }`.
- **Compare two artifacts** → `{ kind: "artifact-studio", path: "<a>", density: "compare", vs: "<b>" }`.

The legacy `iyke_open` kind `"artifact-grid"` is still accepted as an alias for `{ kind: "artifact-studio", density: "grid" }` — old scripts keep working.

Trigger when the user says any of:
- "open this folder in studio" / "open as a grid"
- "open <file> in the studio" / "edit this artifact"
- "compare v2 with v3" / "open <a> next to <b>"
- "switch the studio to loupe" / "open the artifact for editing"

Once mounted, the right rail's Chat tab persists as one thread per folder; the scope chip (folder · artifact · element · compare) travels with each message rather than forking the thread.
