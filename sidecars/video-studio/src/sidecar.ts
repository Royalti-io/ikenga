/**
 * pa-video-studio-sidecar — MCP stdio server for Remotion Studio.
 *
 * Migrated from the legacy custom JSON-line protocol so this binary plugs
 * into the ikenga-desktop pkg-kernel's `SidecarSupervisor` (lifecycle:
 * "long-lived"), the same path PR 2 introduced for hyperframes. The
 * supervisor owns spawn/restart/teardown; this process only handles the
 * MCP surface and the Remotion Studio child-process lifecycle.
 *
 * Tools
 * -----
 *   start_studio   — boot Remotion Studio on a free port, return {port}
 *   stop_studio    — shut down Remotion Studio
 *   get_status     — {port: number|null, running: boolean}
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
 *   • Single Remotion Studio instance per sidecar (start_studio while
 *     running is idempotent — returns the existing port).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "pa-video-studio", version: "0.2.0" };

// start_studio waits for Remotion to bind. If it doesn't ready inside
// this window, the tool call rejects.
const READY_TIMEOUT_MS = 30_000;

// ── Logging ────────────────────────────────────────────────────────────────

const log = (...args: unknown[]) => {
  process.stderr.write(
    `[video-studio] ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`,
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

// ── Remotion CLI discovery (carried over from legacy sidecar) ─────────────

async function findFreePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const { port } = addr;
        srv.close(() => res(port));
      } else {
        srv.close(() => rej(new Error("could not get bound port")));
      }
    });
  });
}

function findRemotionCli(): { bin: string; cwd: string; entry: string } {
  const entryRel = process.env.REMOTION_STUDIO_ENTRY ?? "src/video/index.ts";

  if (process.env.REMOTION_STUDIO_BIN) {
    const bin = process.env.REMOTION_STUDIO_BIN;
    const cwd = process.env.REMOTION_STUDIO_CWD ?? process.cwd();
    return { bin, cwd, entry: resolve(cwd, entryRel) };
  }

  const candidates: string[] = [];
  if (process.env.REMOTION_STUDIO_CWD) {
    candidates.push(process.env.REMOTION_STUDIO_CWD);
  }

  let dir = dirname(process.execPath);
  for (let i = 0; i < 8; i++) {
    candidates.push(resolve(dir, "ikenga-desktop"));
    candidates.push(dir);
    dir = dirname(dir);
  }

  for (const cwd of candidates) {
    const bin = resolve(cwd, "node_modules", ".bin", "remotion");
    if (existsSync(bin)) {
      return { bin, cwd, entry: resolve(cwd, entryRel) };
    }
  }

  throw new Error(
    "could not locate remotion CLI; set REMOTION_STUDIO_CWD to the desktop app root",
  );
}

// ── Port-in-use detection ─────────────────────────────────────────────────
//
// Even though we pre-pick a free port via findFreePort(), Remotion can race
// another process between our probe and its listen(). When that happens we
// notify the supervisor and exit code=2 so it transitions to Blocked
// instead of counting a strike against the retry budget.
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
  send({ jsonrpc: "2.0", method: "pkg/notifications/port_in_use", params: { port } });
  setTimeout(() => {
    void stopStudio().finally(() => process.exit(2));
  }, 50);
}

// ── Active-studio state ────────────────────────────────────────────────────

interface Active {
  child: ChildProcess;
  port: number;
}

let active: Active | null = null;

async function startStudio(): Promise<{ port: number }> {
  if (active) {
    return { port: active.port };
  }

  const cli = findRemotionCli();
  const port = await findFreePort();

  log(`starting remotion studio: cwd=${cli.cwd} entry=${cli.entry} port=${port}`);

  // stdio: ["pipe", "pipe", "pipe"] (not "ignore"). Some Remotion CLI
  // builds detect EOF on stdin and shut down; piping a writable handle
  // we never close keeps the child happy. This is the same fix the
  // hyperframes preview-spawn uses, and matches the supervised-MCP
  // convention from PR 2.
  const child = spawn(
    cli.bin,
    ["studio", cli.entry, `--port=${port}`, "--no-open", "--log=info"],
    {
      cwd: cli.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, BROWSER: "none" },
    },
  );

  active = { child, port };

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
        rejectReady(new Error(`start_studio timed out after ${READY_TIMEOUT_MS}ms`));
      });
    }, READY_TIMEOUT_MS);

    const onReady = () => {
      clearTimeout(timer);
      settle(() => resolveReady({ port }));
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      process.stderr.write(`[remotion-studio] ${text}`);
      notePortInUse(text, port);
      if (!settled && (text.includes(`:${port}`) || text.toLowerCase().includes("server ready"))) {
        onReady();
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      process.stderr.write(`[remotion-studio] ${text}`);
      notePortInUse(text, port);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      settle(() => {
        if (active?.child === child) active = null;
        rejectReady(new Error(`child process: ${err.message}`));
      });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      log(`remotion studio exited code=${code}`);
      if (active?.child === child) active = null;
      settle(() => {
        rejectReady(new Error(`remotion studio exited (code=${code}) before ready`));
      });
    });
  });
}

async function stopStudio(): Promise<void> {
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
    name: "start_studio",
    description: "Boot Remotion Studio on a free 127.0.0.1 port. Idempotent: returns the existing port if already running.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "stop_studio",
    description: "Shut down the running Remotion Studio (no-op if not running).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_status",
    description: "Report the running Studio port (null if idle).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

async function handleToolCall(name: string): Promise<Record<string, unknown>> {
  switch (name) {
    case "start_studio": {
      const { port } = await startStudio();
      return toolResult({ port }, `studio listening on :${port}`);
    }
    case "stop_studio": {
      const wasActive = active !== null;
      await stopStudio();
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
    void stopStudio().then(() => process.exit(0));
  });

  process.on("SIGTERM", () => {
    void stopStudio().then(() => process.exit(0));
  });
  process.on("SIGINT", () => {
    void stopStudio().then(() => process.exit(0));
  });
}

main().catch((e) => {
  log(`fatal: ${(e as Error).message}`);
  process.exit(1);
});
