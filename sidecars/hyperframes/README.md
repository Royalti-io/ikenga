# pa-hyperframes sidecar

Bun-compiled shim that boots HyperFrames preview servers for the desktop app's
HyperFrames mini-app. Wraps `hyperframes preview --port=<n>` per project,
supporting dynamic project switching without respawning the host process.

## Why a shim?

Same constraints as `pa-video-studio`: HyperFrames' preview server is a Node
app with watchers and a headless-Chrome render path — not bun-compile-able.
The shim handles port allocation, the JSON handshake, and project lifecycle so
the Tauri/React layers only deal with a single binary.

## Project layout

Projects live in `ikenga-desktop/hyperframes-projects/<name>/` (bundled
with the desktop app at build time). Each project must include its own
`node_modules/.bin/hyperframes` (project-local install, mirrors how
`royalti-video-engine/packages/hyperframes/projects/<name>/` is structured —
the wrapper script there `cd`s into the project and runs the local CLI).

Override the root with `HYPERFRAMES_PROJECTS_DIR=/abs/path` if you want to
point the sidecar at an external checkout during development.

## Protocol

MCP stdio (newline-delimited JSON-RPC 2.0). Spawned by the pkg-kernel's
`SidecarSupervisor` via the `com.royalti.hyperframes` package's
`manifest.mcp[]` entry (`lifecycle: "long-lived"`).

Tools:

| Tool            | Args                | Returns                                 |
|-----------------|---------------------|-----------------------------------------|
| `list_projects` | `{}`                | `{ projects: string[] }`                |
| `open_project`  | `{ slug: string }`  | `{ project: string, port: number }`     |
| `close_project` | `{}`                | `{ closed: boolean }`                   |
| `get_status`    | `{}`                | `{ project: string\|null, port: number\|null }` |

Only one project preview runs at a time — `open_project` of a different
slug tears down the previous preview before booting the new one. Same-slug
calls are idempotent.

Stderr is free-form logging (drained by the supervisor; never JSON).

## Build

```bash
./build.sh                              # uses host triple
./build.sh aarch64-apple-darwin         # cross-target
```

Output: `dist/pa-hyperframes-<triple>` — referenced from
`src-tauri/tauri.conf.json:bundle.externalBin`.
