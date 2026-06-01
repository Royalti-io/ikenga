# Contributing to ikenga-desktop (the shell)

## Versioning & releases — Changesets

The shell uses [Changesets](https://github.com/changesets/changesets) to derive
its version. It is a **private Tauri app** — not published to npm — so the
release model is: Changesets owns the version, and the asset build still runs on
the `v*` tag push.

**Every PR that changes app behaviour should include a changeset:**

```bash
bunx changeset          # pick patch / minor / major + write a summary
git add .changeset
```

- **patch** — bug fixes, internal-only changes
- **minor** — new features (this is what the 0.1.1 → 0.2.0 bump should have been)
- **major** — breaking changes

### What happens on merge

1. On merge to `main`, the **Version** workflow opens a `chore: version packages`
   PR. Its version step runs `changeset version` **and** `scripts/sync-version.mjs`,
   which propagates the new version into `package.json`, `src-tauri/tauri.conf.json`,
   `src-tauri/Cargo.toml`, and `src-tauri/Cargo.lock` — the three places that used
   to drift on manual bumps.
2. Merging that PR runs `scripts/tag-release.sh`, which pushes a `v<version>` tag.
3. The tag triggers **release.yml** — the existing build that produces the
   `.deb`/assets and the GitHub Release.

Don't hand-edit the version in any of the four files, and don't push `v*` tags
manually — Changesets + the version workflow own that now.
