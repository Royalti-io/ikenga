---
"ikenga-desktop": patch
---

Give each app pkg its own activity-bar mode. App pkgs (Suite, Tasks, …) previously borrowed App mode and their published menu clobbered the shell's main nav; now each pkg owns a dynamic `pkg:<id>` mode — its rail icon highlights when active, the sidebar renders the pkg's menu as that mode's body, and App mode (⌘1) always keeps Home/Sessions/Scratchpads/Todos/Cron. Deep links to `/pkg/<id>/…` re-sync the rail; a persisted mode for a since-uninstalled pkg reconciles back to App once the kernel snapshot loads (shell-store persist v13→14, migration preserves pkg modes). The iyke `/iyke/mode` endpoint accepts `pkg:` modes, and its stale Rust validator (which silently rejected `pkgs`/`ngwa`/`artifact-grid`) now mirrors the live core-mode set.
