# Pre-extraction history

This repo was carved out of the `royalti-co` monorepo on 2026-05-06 via `git subtree split --prefix=ikenga-desktop`.

Before that, the codebase lived at:
- `royalti-co/ikenga-desktop/` (post 2026-04-25 rename)
- `royalti-co/royalti-pa-desktop/` (initial path, pre-rename)

`subtree split` only captures commits that touched the requested prefix, so the pre-rename history (≈490 commits under `royalti-pa-desktop/`) is **not** part of this repo's `git log`. It remains intact in the monorepo for archaeology.

If full unified history is needed later (e.g. before tagging 1.0), re-extract with:

```bash
pip install --user git-filter-repo

cd ~/royalti-co  # fresh clone recommended — filter-repo rewrites history
git filter-repo \
  --path royalti-pa-desktop --path ikenga-desktop \
  --path-rename royalti-pa-desktop/:./ \
  --path-rename ikenga-desktop/:./
```

Then force-push to `royalti-io/ikenga`.
