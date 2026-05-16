---
description: Open a folder as a Lightroom-style artifact grid in the Ikenga desktop app.
argument-hint: <folder-path>
---

Use the `iyke_open` tool with `kind: "artifact-grid"` and `path: $ARGUMENTS` to open the folder as an artifact-grid pane. The grid shows one cell per `.html` file in the folder with a live iframe thumbnail; sibling folders named after their parent `.html` file render as stacked variants. Pin comments overlay each thumbnail.

Use this when the user asks to "open a folder as a grid", "see all the artifacts in X", or wants a multi-artifact contact-sheet view rather than the single-artifact pane.
