# pa-video-studio sidecar

Bun-compiled shim that boots Remotion Studio for the desktop app's Video Engine
mini-app. Wraps `./node_modules/.bin/remotion studio` so the Tauri shell layer
only deals with one binary.

## Why a shim and not a direct spawn?

Remotion Studio is a webpack/esbuild dev server with file watchers and a
preview UI — it can't be `bun build --compile`'d into a single file. Instead,
this sidecar:

1. Picks a free localhost port (`findFreePort()`).
2. Resolves the Remotion CLI at `ikenga-desktop/node_modules/.bin/remotion`
   (walks up from the binary location, or honours `REMOTION_STUDIO_CWD`).
3. Spawns the CLI as a child process with `--port=<n> --no-open`.
4. Emits a `{type:"ready",port}` frame on stdout once Studio is listening.
5. Forwards Studio's stdout/stderr to its own stderr (host app logs them).
6. Tears down on stdin close or `{type:"shutdown"}` frame.

The Tauri Rust side reads the `ready` frame, hands the port to the frontend,
which embeds `http://127.0.0.1:<port>` in an `<iframe>` inside the
`VideoEngineMode` rail pane.

## Protocol

Stdout (line-delimited JSON):

```
{ "type": "ready", "port": 12345 }
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

Output: `dist/pa-video-studio-<triple>` — referenced from
`src-tauri/tauri.conf.json:bundle.externalBin`.

## Runtime requirements

- The desktop app's `node_modules` must contain `@remotion/cli` and
  `@remotion/studio-server` (already pinned in `ikenga-desktop/package.json`).
- Node is **not** required on the user's machine — the bun-compiled binary
  hosts its own runtime, but Remotion's CLI itself is a Node script. We
  invoke it via the desktop app's bundled `node_modules/.bin/remotion`
  shebang, which on dev machines points at the system Node.
- For shipped builds, this is the Phase D upgrade path (bundle Node alongside
  the binary or migrate to `@remotion/studio-server` as a Bun-native import).
