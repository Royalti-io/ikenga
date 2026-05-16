---
description: List sibling variants of an artifact (e.g. cfo-daily.html, cfo-daily-v2.html, ./cfo-daily/v3-dark.html).
argument-hint: <canonical-artifact-path>
---

The Studio's version strip treats every `<basename>*<ext>` sibling in the parent dir *and* every file inside a same-name subfolder as a variant of the canonical artifact. Reproduce the same view from claude by:

1. Use `fs_list` (via the shell's Tauri command surface or your file-system MCP) on the **parent directory** of `$ARGUMENTS`. Filter entries whose name starts with the canonical basename and whose extension matches.
2. Use `fs_list` on **`<parentDir>/<basename>/`** (when it exists) and include `.html` (or kind-matching) files as variants too.
3. Sort variants most-recently-modified-first; keep the canonical file at index 0.

When the user asks "what versions of X exist?" / "show me the variants of <file>" / "list the v's", run this listing and reply with the names + modification times. Then offer to open one — `iyke_open` with `kind: "artifact-studio", path: "<sibling>", density: "loupe"` — or two in compare via `{ density: "compare", vs: "<other>" }`.

No filesystem mutations here; this is purely descriptive. See `branch` / `promote` for the write operations.
