---
description: Branch a new variant of an artifact by copying it to a fresh `-vN` filename.
argument-hint: <canonical-artifact-path>
---

Spin off a new variant of `$ARGUMENTS` for parallel iteration. Implementation:

1. List parent-directory siblings via `fs_list` to find the next free `<basename>-vN<ext>` slot. If the canonical itself already carries a `-vN` suffix, root against the family (`foo-v2.html` → next free `foo-v3.html`, not `foo-v2-v2.html`).
2. `fs_read` the canonical artifact and `fs_write` the bytes to the new path.
3. Open the new variant in the Studio loupe so the user can start editing — `iyke_open` with `kind: "artifact-studio", path: "<new-path>", density: "loupe"`.

Use when the user says "branch this", "start a v3", "make a copy I can edit independently", or clicks `+ new` in the Studio's version strip.

Related: `promote` makes a variant canonical via filename swap; `versions` lists the variant set.
