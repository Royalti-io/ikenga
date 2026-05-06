# pa-storyboard sidecar

Bun-compiled shim that boots the `royalti-video-engine/storyboard-app/` dev
stack (Vite SPA on 3105 + Express API on 3106) for the desktop app's
Storyboard mini-app.

## Why a shim?

Same constraints as the other video sidecars — Vite + Express are Node
processes, so we can't bun-compile them. The shim:

1. Resolves `royalti-video-engine/storyboard-app/` by walking up from the
   binary location (or honours `STORYBOARD_APP_DIR`).
2. Spawns the storyboard-app's `npm run dev` (which uses `concurrently -k`
   to manage Vite and the Express server together).
3. Polls `http://127.0.0.1:3105/api/health` until it returns 200, then
   emits a `ready` frame so we know both halves of the stack are up.
4. Tears down on stdin close or shutdown frame.

Vite is configured `strictPort: true` on port 3105 — if the port is taken,
the spawn fails and the sidecar surfaces the error.

## Protocol

Stdout (line-delimited JSON):

```
{ "type": "ready", "port": 3105 }
{ "type": "exit",  "code": 0 }
{ "type": "error", "error": "…" }
```

Stdin (line-delimited JSON):

```
{ "type": "shutdown" }
```

## Build

```bash
./build.sh                              # uses host triple
./build.sh aarch64-apple-darwin         # cross-target
```

Output: `dist/pa-storyboard-<triple>` — referenced from
`src-tauri/tauri.conf.json:bundle.externalBin`.

## Runtime requirements

- `royalti-video-engine/storyboard-app/` must be a sibling of
  `ikenga-desktop/` (or set `STORYBOARD_APP_DIR`).
- The storyboard-app's `node_modules` must already be installed
  (`cd royalti-video-engine/storyboard-app && npm install`).
- System `npm` (or `bun` if a `bun.lock` exists) is required on the user's
  machine — same Phase D upgrade path as the other sidecars.
