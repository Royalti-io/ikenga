-- Strip-down: drop tables that owned schema for the now-retired in-shell
-- apps. The data they held was app-specific (render queue, mbox sync state,
-- storyboard authoring) and the matching Rust commands + frontend modules
-- were removed in Phase 3c/3d. Fresh installs never see these tables;
-- existing dev installs lose any data they held — acceptable since the
-- replacement homes are app pkgs (com.ikenga.email, com.ikenga.studio)
-- which keep their own per-pkg migrations under pkg_migrations.

DROP TABLE IF EXISTS render_jobs;
DROP TABLE IF EXISTS mbox_sync_state;
DROP TABLE IF EXISTS storyboard_jobs;
DROP TABLE IF EXISTS storyboard_beats;
DROP TABLE IF EXISTS storyboards;
