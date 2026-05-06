// Bundle entry for the viewer-server's HTML injection. The viewer-server
// (`src-tauri/src/viewer_server/mod.rs`) reads the bundled output of this
// file via `include_str!` and injects it into every served HTML response,
// so author-written design previews get the same iyke DOM/console/network
// bridge the sidecars get from importing `./iyke-bridge` directly.
//
// Re-bundle with `bun run iyke:bundle` after editing the bridge.

import { mountIykeIframeBridge } from './iframe-bridge';

mountIykeIframeBridge();
