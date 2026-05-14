// Bundle entry for the viewer-server's HTML injection. The viewer-server
// (`src-tauri/src/viewer_server/mod.rs`) reads the bundled output of this
// file via `include_str!` and injects it into every served Ikenga artifact's
// <head>, so the `art` bridge surface is available to the artifact's React
// code without depending on the inline polyfill in the HTML.
//
// Re-bundle with `bun run artifact:bundle` after editing the bridge.

import { mountArtifactBridge } from './bridge';

mountArtifactBridge();
