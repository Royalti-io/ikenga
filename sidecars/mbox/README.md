# pa-mbox-sidecar

Self-contained Thunderbird mbox parser, bundled with the desktop app.

Wraps the existing pure-TS reader (vendored from `scripts/lib/thunderbird-reader.ts`) in a line-delimited JSON-RPC loop over stdio. Compiled to a single binary via `bun build --compile` and shipped as a Tauri externalBin.

## Build

```bash
./build.sh                              # current host triple
./build.sh aarch64-apple-darwin         # cross-compile (bun supports it)
```

Output: `dist/pa-mbox-<rust-triple>` (~97 MB, includes bun runtime).

## Tauri integration

- `src-tauri/tauri.conf.json` → `bundle.externalBin: ["../sidecars/mbox/dist/pa-mbox"]`
- Rust bridge: `src-tauri/src/commands/mbox.rs`
- Tauri commands: `mbox_read_all`, `mbox_ping`
- Frontend wrapper: `src/lib/tauri-cmd.ts` → `mboxReadAll`, `mboxPing`

The frontend never spawns the sidecar directly. Calls go: TS `mboxReadAll()` → `invoke('mbox_read_all', …)` → Rust `mbox_read_all` → `app.shell().sidecar("pa-mbox").spawn()` → JSON-RPC → typed `ParsedEmail[]` back.

## Protocol

Line-delimited JSON over stdio. One request → one or more frames terminated by `done`.

**Request:**
```json
{"id": "1", "method": "readAllMailboxes", "params": {"sinceIso": "2026-04-30T00:00:00Z"}}
```

**Response stream:**
```json
{"id": "1", "type": "email", "data": {…ParsedEmail}}
{"id": "1", "type": "email", "data": {…}}
{"id": "1", "type": "done", "count": 142}
```

**Methods:**
- `ping` → `pong` + `done`
- `listMailboxes` → `mailboxes` (string[]) + `done`
- `readAllMailboxes({ sinceIso?, chunkSize?, mailboxes? })` → stream of `email` + `done`
- `readMboxFile({ path, inboxSource, newestFirst, chunkSize?, sinceIso? })` → stream of `email` + `done`
- `readSentMessageIds({ sinceIso?, chunkSize? })` → `ids` + `done`

Errors are emitted as `{type: "error", error: "..."}` followed by `done`. stderr carries logs; never write logs to stdout (corrupts the protocol).

## Tests

```bash
bun test
```

Covers ping, listMailboxes, fixture parse (plain / quoted-printable / base64 / multipart / MIME-encoded subjects), invalid JSON, unknown method.

## Manual smoke test

```bash
echo '{"id":"1","method":"ping"}' | ./dist/pa-mbox-x86_64-unknown-linux-gnu
# → {"id":"1","type":"pong"}
#   {"id":"1","type":"done","count":0}
```
