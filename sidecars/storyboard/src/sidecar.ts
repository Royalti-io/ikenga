/**
 * pa-storyboard-sidecar — MCP stdio server for the royalti-video-engine
 * storyboard-app dev stack (Vite on 3105 + Express API on 3106).
 *
 * Migrated from the legacy custom JSON-line protocol so this binary plugs
 * into the ikenga-desktop pkg-kernel's `SidecarSupervisor` (lifecycle:
 * "long-lived"), the same path PR 2/4 introduced for hyperframes /
 * video-studio. The supervisor owns spawn/restart/teardown; this process
 * only handles the MCP surface and the dev-stack child lifecycle.
 *
 * Tools
 * -----
 *   start_storyboard — boot the storyboard-app dev stack, return {port}
 *                      (the Vite port, 3105 — Express on 3106 is internal,
 *                      proxied through Vite's /api/*).
 *   stop_storyboard  — tear down the dev stack
 *   get_status       — {port: number|null, running: boolean}
 *
 * Wire
 * ----
 *   • Stdin / stdout: newline-delimited JSON-RPC 2.0.
 *   • Stderr: free-form logging (drained by the supervisor; never JSON).
 *   • No notifications emitted in v1.
 *
 * v1 scope:
 *   • No `_meta.royaltiAuth.token` enforcement (TODO Q3 from
 *     2026-05-04-hyperframes-pkg-mount.md).
 *   • Single dev-stack instance per sidecar (start_storyboard while
 *     running is idempotent — returns the existing port).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "pa-storyboard", version: "0.2.0" };

const VITE_PORT = 3105;
const HEALTH_URL = `http://127.0.0.1:${VITE_PORT}/api/health`;
// Vite cold-builds the storyboard-app on first boot — generous timeout
// matches the 75s STORYBOARD_READY_TIMEOUT the legacy Rust watcher used.
const READY_TIMEOUT_MS = 75_000;
const POLL_INTERVAL_MS = 400;

// ── Logging ────────────────────────────────────────────────────────────────

const log = (...args: unknown[]) => {
  process.stderr.write(
    `[storyboard] ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`,
  );
};

// ── MCP framing ────────────────────────────────────────────────────────────

type JsonRpcId = number | string | null;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

function send(msg: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function reply(id: JsonRpcId, result: unknown): void {
  if (id === undefined || id === null) return;
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id: JsonRpcId, code: number, message: string): void {
  if (id === undefined || id === null) {
    log("dropped error (no id):", message);
    return;
  }
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function toolResult(extra: Record<string, unknown>, summary: string): Record<string, unknown> {
  return { content: [{ type: "text", text: summary }], ...extra };
}

// ── storyboard-app discovery ──────────────────────────────────────────────

function realpathSyncSafe(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Locate `royalti-video-engine/storyboard-app/`. STORYBOARD_APP_DIR wins;
 * else walk up from `process.execPath` looking for a sibling
 * `royalti-video-engine/storyboard-app/`.
 */
function findStoryboardApp(): string {
  if (process.env.STORYBOARD_APP_DIR) {
    const real = realpathSyncSafe(process.env.STORYBOARD_APP_DIR);
    if (existsSync(resolve(real, "package.json"))) return real;
  }

  let dir = dirname(process.execPath);
  for (let i = 0; i < 8; i++) {
    const candidate = resolve(dir, "royalti-video-engine", "storyboard-app");
    if (existsSync(resolve(candidate, "package.json"))) return candidate;
    dir = dirname(dir);
  }
  throw new Error(
    "could not locate royalti-video-engine/storyboard-app/ (set STORYBOARD_APP_DIR)",
  );
}

async function pollUntilReady(deadline: number): Promise<boolean> {
  while (Date.now() < deadline) {
    try {
      const res = await fetch(HEALTH_URL, {
        signal: AbortSignal.timeout(800),
      });
      if (res.ok) return true;
    } catch {
      // Server not up yet; keep polling.
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return false;
}

// ── Port-in-use detection ─────────────────────────────────────────────────
//
// Vite/concurrently log a recognizable line on EADDRINUSE; we match early
// (before the child crash propagates as a code=1 exit), notify the
// supervisor, then exit code=2 so it can transition to Blocked instead of
// counting a strike.
const PORT_IN_USE_RE =
  /(EADDRINUSE|address already in use|port\s+(\d+)\s+is already in use)/i;

let portInUseExitArmed = false;

function notePortInUse(text: string, defaultPort: number): void {
  if (portInUseExitArmed) return;
  const m = text.match(PORT_IN_USE_RE);
  if (!m) return;
  const captured = m[2] ? Number.parseInt(m[2], 10) : defaultPort;
  const port = Number.isFinite(captured) ? captured : defaultPort;
  portInUseExitArmed = true;
  log(`port-in-use detected (port=${port}); notifying supervisor and exiting code=2`);
  // Notification (no id). Supervisor reads, marks Blocked, schedules 10s
  // retry. Send before the kill-and-exit dance so the supervisor's
  // read-loop sees the line ahead of stdout EOF.
  send({ jsonrpc: "2.0", method: "pkg/notifications/port_in_use", params: { port } });
  // Give stdout a tick to flush, then bring the child down and exit.
  setTimeout(() => {
    void stopStoryboard().finally(() => process.exit(2));
  }, 50);
}

// ── Active dev-stack state ────────────────────────────────────────────────

interface Active {
  child: ChildProcess;
  port: number;
}

let active: Active | null = null;

async function startStoryboard(): Promise<{ port: number }> {
  if (active) {
    return { port: active.port };
  }

  const appDir = findStoryboardApp();

  // Pick the package manager — prefer bun if a bun lockfile is present, else
  // fall back to npm (the storyboard-app's README + lockfile use npm). The
  // dev script uses `concurrently -k` so killing the parent kills both
  // children (Vite + Express).
  const useBun =
    existsSync(resolve(appDir, "bun.lock")) || existsSync(resolve(appDir, "bun.lockb"));
  const cmd = useBun ? "bun" : "npm";
  const args = ["run", "dev"];

  log(`starting storyboard-app dev server: cwd=${appDir} port=${VITE_PORT} pm=${cmd}`);

  // stdio: ["pipe", "pipe", "pipe"] (not "ignore"). Same defensive choice
  // as the video-studio sidecar — keeps a writable stdin handle open so
  // any child process that detects EOF on its stdin doesn't shut down.
  const child = spawn(cmd, args, {
    cwd: appDir,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, BROWSER: "none" },
  });

  active = { child, port: VITE_PORT };

  child.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    process.stderr.write(`[storyboard-app] ${text}`);
    notePortInUse(text, VITE_PORT);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    process.stderr.write(`[storyboard-app] ${text}`);
    notePortInUse(text, VITE_PORT);
  });

  return new Promise((resolveReady, rejectReady) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const timer = setTimeout(() => {
      settle(() => {
        try {
          child.kill("SIGTERM");
        } catch {
          // ignore
        }
        if (active?.child === child) active = null;
        rejectReady(
          new Error(
            `start_storyboard timed out after ${READY_TIMEOUT_MS}ms (port ${VITE_PORT} never became healthy)`,
          ),
        );
      });
    }, READY_TIMEOUT_MS);

    child.on("error", (err) => {
      clearTimeout(timer);
      settle(() => {
        if (active?.child === child) active = null;
        rejectReady(new Error(`child process: ${err.message}`));
      });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      log(`storyboard-app exited code=${code}`);
      if (active?.child === child) active = null;
      settle(() => {
        rejectReady(new Error(`storyboard-app exited (code=${code}) before ready`));
      });
    });

    // Health-poll race: resolve when /api/health returns 200 (Vite proxies
    // the route to the Express sidecar), reject on the timeout above.
    void (async () => {
      const ready = await pollUntilReady(Date.now() + READY_TIMEOUT_MS);
      if (ready) {
        clearTimeout(timer);
        settle(() => resolveReady({ port: VITE_PORT }));
      }
      // If !ready the timer above already fired; nothing to do.
    })();
  });
}

async function stopStoryboard(): Promise<void> {
  if (!active) return;
  const { child } = active;
  active = null;
  try {
    child.kill("SIGTERM");
  } catch {
    // ignore
  }
  await new Promise((r) => setTimeout(r, 800));
  if (!child.killed) {
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
  }
}

// ── MCP request dispatch ───────────────────────────────────────────────────

const TOOLS = [
  {
    name: "start_storyboard",
    description:
      "Boot the storyboard-app dev stack (Vite + Express) on 127.0.0.1:3105. Idempotent: returns the existing port if already running.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "stop_storyboard",
    description: "Shut down the running storyboard-app dev stack (no-op if not running).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_status",
    description: "Report the running Vite port (null if idle) and a running boolean.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

async function handleToolCall(name: string): Promise<Record<string, unknown>> {
  switch (name) {
    case "start_storyboard": {
      const { port } = await startStoryboard();
      return toolResult({ port }, `storyboard listening on :${port}`);
    }
    case "stop_storyboard": {
      const wasActive = active !== null;
      await stopStoryboard();
      return toolResult({ stopped: wasActive }, wasActive ? "stopped" : "not running");
    }
    case "get_status": {
      const port = active?.port ?? null;
      const running = active !== null;
      return toolResult({ port, running }, running ? `running on :${port}` : "idle");
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

async function dispatch(req: JsonRpcRequest): Promise<void> {
  const id = req.id ?? null;

  // TODO(Q3 auth): validate req.params._meta.royaltiAuth.token.

  switch (req.method) {
    case "initialize":
      reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
      return;

    case "notifications/initialized":
    case "notifications/cancelled":
      return;

    case "tools/list":
      reply(id, { tools: TOOLS });
      return;

    case "tools/call": {
      const params = (req.params ?? {}) as { name?: string };
      const toolName = params.name;
      if (typeof toolName !== "string") {
        replyError(id, -32602, "tools/call missing params.name");
        return;
      }
      try {
        const result = await handleToolCall(toolName);
        reply(id, result);
      } catch (e) {
        replyError(id, -32000, (e as Error).message ?? String(e));
      }
      return;
    }

    case "ping":
      reply(id, {});
      return;

    default:
      replyError(id, -32601, `method not found: ${req.method}`);
  }
}

// ── Stdin reader ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  process.stdin.setEncoding("utf8");
  let buf = "";

  process.stdin.on("data", (chunk) => {
    buf += chunk;
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let req: JsonRpcRequest;
      try {
        req = JSON.parse(trimmed) as JsonRpcRequest;
      } catch (e) {
        log(`parse error: ${(e as Error).message}: ${trimmed.slice(0, 120)}`);
        continue;
      }
      void dispatch(req).catch((e) => {
        log(`dispatch crashed for method=${req.method}: ${(e as Error).message}`);
        replyError(req.id ?? null, -32603, `internal: ${(e as Error).message}`);
      });
    }
  });

  process.stdin.on("end", () => {
    log("stdin closed; shutting down");
    void stopStoryboard().then(() => process.exit(0));
  });

  process.on("SIGTERM", () => {
    void stopStoryboard().then(() => process.exit(0));
  });
  process.on("SIGINT", () => {
    void stopStoryboard().then(() => process.exit(0));
  });
}

main().catch((e) => {
  log(`fatal: ${(e as Error).message}`);
  process.exit(1);
});
