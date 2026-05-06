# Tasks — kernel package `com.royalti.tasks` (host-builtin marker install)

This directory is **owned by the kernel package `com.royalti.tasks`** as of 2026-05-04, and *will stay that way* — Tasks is correctly modelled as a **host-builtin marker install**, not a third-party iframe-mounted package. Resolved-by-design in `.company/technical/decisions/2026-05-04-studio-as-packages.md`.

## What's a builtin vs a third-party package

After the iframe-mount mechanism landed (Gap 1 follow-up), the kernel supports two mount modes:

| Mode | Where the UI lives | How it loads | Use for |
|---|---|---|---|
| **Builtin** (this) | `src/routes/<feature>/...` in the host repo | TanStack file-based router at compile time | In-tree features that need to share the host's React tree, query cache, and state stores |
| **Third-party** | `<install_path>/dist/index.html` shipped by the package | Catch-all `/pkg/<pkgId>/<path>` → iframe via the pkg-content HTTP server | Installable packages, including everything we want renderable in Claude.ai/ChatGPT as MCP Apps (e.g. Studio sub-packages) |

Tasks is in column 1: it shares the host's TanStack Query cache with the rest of the desktop app, drives the dock badge, and is part of the same React tree as `/finance`, `/sessions`, etc. Iframing it would lose all of that for no benefit.

## How the marker install works

- `manifest.ui.routes` declares `/tasks`, `/tasks/`, `/tasks/$taskId` with `kind: "component"`.
- `UiRoutesRegistry` records that ownership claim — `pkgKernelStatus()` shows the routes registered against this package.
- The `pkg_content` registry is a **no-op** for component-kind routes (it only registers iframe-kind dist roots), so Tasks doesn't appear in the content-server entries.
- The route files in this directory are what render. Uninstalling the package removes the registry entries but does NOT make `/tasks` 404 — the file router is still serving the route at compile-time.
- A third-party package declaring `kind: "component"` for a non-builtin path will render `<PkgRouteUnmountable />` from the catch-all (component-kind is documented as builtin-only; the catch-all surfaces the mismatch with a useful error).

## Editing convention

Make changes here in `src/routes/tasks/` (this is what runs). When the manifest needs to reflect a new shape (new file, renamed export, new settings key), re-sync the package source and bump the manifest:

```bash
cp -r src/routes/tasks/*           /tmp/test-pkg-com.royalti.tasks/ui/
cp src/lib/queries/tasks.ts        /tmp/test-pkg-com.royalti.tasks/queries/tasks.ts
# edit /tmp/test-pkg-com.royalti.tasks/manifest.json if needed
```

Then re-install via `/install` (catalog → Tasks) or call `pkg_install_from_path` directly.

## Smoke

- `/tasks-pkg-smoke` — install + verify all four registries (ui_routes, permissions, queries, settings) + uninstall.
- `?phase=verify` asserts a prior install is still intact (boot-replay test).
- The iframe mount mechanism has its own smoke at `/iframe-mount-smoke` — uses synthetic fixtures, doesn't touch Tasks.

## See also

- `.company/technical/decisions/2026-05-04-tasks-kernel-migration.md` — the original migration write-up + Gap 5 (source-of-truth drift) which is now resolved-by-design.
- `.company/technical/decisions/2026-05-04-studio-as-packages.md` — the "what's a builtin vs a package" policy doc.
