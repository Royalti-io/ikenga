#!/usr/bin/env node
// Wipe stale AppImage AppDirs before bundling.
//
// linuxdeploy's GTK plugin creates the GTK-module rpath symlinks with a bare
// `ln -s` (no `-f`):
//
//   for directory in immodules printbackends pixbuf; do
//     ln -s "<module>.so" "$APPDIR/usr/lib"   # ← fails if the link exists
//   done
//
// tauri-bundler does NOT wipe `bundle/appimage/<App>.AppDir` between builds, so
// the second local `tauri build` re-runs the plugin against an AppDir that
// still has those symlinks and dies with `ln: ... File exists` →
// `Failed to run plugin: gtk (exit code: 1)`. CI never hits it (fresh runner =
// clean AppDir), which is why releases ship a working AppImage but local builds
// don't. Removing the AppDir up front makes every build a clean first run.
//
// Wired as `build.beforeBundleCommand` in tauri.conf.json — runs on every
// platform's bundle step; on macOS/Windows (and fresh trees) the path simply
// doesn't exist and this is a no-op.

import { existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const shellRoot = dirname(dirname(fileURLToPath(import.meta.url))); // scripts/ → shell/
const targetRoot = join(shellRoot, 'src-tauri', 'target');

if (!existsSync(targetRoot)) process.exit(0);

let removed = 0;
// Per-target tree (e.g. x86_64-unknown-linux-gnu) plus the default `release`.
for (const entry of readdirSync(targetRoot, { withFileTypes: true })) {
	if (!entry.isDirectory()) continue;
	const appimageDir = join(targetRoot, entry.name, 'release', 'bundle', 'appimage');
	if (!existsSync(appimageDir)) continue;
	for (const sub of readdirSync(appimageDir, { withFileTypes: true })) {
		if (sub.isDirectory() && sub.name.endsWith('.AppDir')) {
			const full = join(appimageDir, sub.name);
			rmSync(full, { recursive: true, force: true });
			console.log(`[clean-appimage] removed stale ${full}`);
			removed++;
		}
	}
}

if (removed === 0) console.log('[clean-appimage] no stale AppDir to remove');
