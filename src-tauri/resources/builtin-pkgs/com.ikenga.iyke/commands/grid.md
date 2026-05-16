---
description: Open a folder as a Lightroom-style artifact grid in the Ikenga desktop app.
argument-hint: <folder-path>
---

Use the `iyke_open` tool with `kind: "artifact-studio"`, `path: $ARGUMENTS`, `density: "grid"` to open the folder as the Studio at grid density. The grid shows one cell per `.html` file in the folder with a live iframe thumbnail; sibling folders named after their parent `.html` file render as stacked variants. Pin comments overlay each thumbnail.

The legacy `kind: "artifact-grid"` is still accepted as an alias for the grid-density Studio — prefer `artifact-studio` in new code; see `studio` for the full Studio surface (loupe + compare).

Use this when the user asks to "open a folder as a grid", "see all the artifacts in X", or wants a multi-artifact contact-sheet view rather than the single-artifact pane.
