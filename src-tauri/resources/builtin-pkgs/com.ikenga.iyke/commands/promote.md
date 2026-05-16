---
description: Promote a variant artifact to canonical by swapping filenames with the existing canonical.
argument-hint: <variant-path> <canonical-path>
---

Make `<variant-path>` the canonical artifact and demote the existing canonical to the variant's prior name. This is a three-step on-disk rename:

1. Move `<canonical>` to a temporary basename in the same directory (e.g. `.<canonicalName>.swap-<timestamp>`).
2. Move `<variant>` to `<canonicalName>`.
3. Move the temp file to `<variantName>`.

Use `fs_rename` for each step. Abort on the first error — never leave the user with two files claiming the canonical name. After a successful swap, suggest opening the new canonical in loupe (`iyke_open` with `kind: "artifact-studio", path: "<canonical>", density: "loupe"`) so the user can review what they just promoted.

Use this when the user says "make this the new version", "promote v3 to canonical", "switch <variant> to be the main file", or clicks "make canonical" from inside the Studio's compare density.

Related: `branch` writes a fresh copy under a `-vN` name (no swap); `versions` lists what's available.
