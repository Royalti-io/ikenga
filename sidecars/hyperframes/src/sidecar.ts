/**
 * pa-hyperframes-sidecar — MCP stdio server for the HyperFrames pkg.
 *
 * Replaces the old custom JSON-line protocol with the MCP wire format
 * (newline-delimited JSON-RPC 2.0) so this binary plugs into the
 * ikenga-desktop pkg-kernel's `SidecarSupervisor` (lifecycle:
 * "long-lived"). The supervisor owns spawn/restart/teardown; this process
 * only handles the MCP surface and the per-project preview-server lifecycle.
 *
 * Tools
 * -----
 *   list_projects      — enumerate project slugs under HYPERFRAMES_PROJECTS_DIR
 *   open_project       — boot a per-slug preview server, returns {port, project}
 *   close_project      — shut down one slug (default: most-recent), or all
 *   get_status         — {project|null, port|null} for a specific slug or
 *                        the most-recently-opened one (compat fallback)
 *   list_active        — array of {project, port} for every running preview
 *
 * Wire
 * ----
 *   • Stdin / stdout: newline-delimited JSON-RPC 2.0.
 *   • Stderr: free-form logging (drained by the supervisor; never JSON).
 *   • No notifications emitted in v1 — supervisor surface state via
 *     pkg_kernel_status, and per-tool failures come back as JSON-RPC errors.
 *
 * v1 scope (per design doc 2026-05-04):
 *   • No `_meta.royaltiAuth.token` enforcement (TODO Q3).
 *   • Multiple previews can run concurrently — one Active per slug, capped
 *     at MAX_ACTIVE_PROJECTS so a runaway caller can't fork-bomb the host.
 *     `open_project(slug)` of an already-open slug is idempotent.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "pa-hyperframes", version: "0.1.0" };

// open_project waits for the preview server to bind. If it doesn't ready
// inside this window, the tool call rejects (the caller / supervisor can
// retry). Matches the heuristic in the prior implementation (4s ready
// fallback) plus headroom for cold-start node_modules thrash.
const OPEN_READY_TIMEOUT_MS = 12_000;

// Concurrency guard. Each preview is a Vite/Studio dev server (Node + a
// Chromium pool); without a cap a panicked caller could spawn dozens.
const MAX_ACTIVE_PROJECTS = 4;

// ── Logging (always stderr; never poison stdout) ────────────────────────────

const log = (...args: unknown[]) => {
  process.stderr.write(
    `[hyperframes] ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`,
  );
};

// ── MCP framing helpers ────────────────────────────────────────────────────

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

function replyError(id: JsonRpcId, code: number, message: string, data?: unknown): void {
  if (id === undefined || id === null) {
    log("dropped error (no id):", message);
    return;
  }
  const err: Record<string, unknown> = { code, message };
  if (data !== undefined) err.data = data;
  send({ jsonrpc: "2.0", id, error: err });
}

// MCP `tools/call` results are typically `{ content: [...], ...extra }`.
// Extra fields ride alongside content for callers that want structured
// values without parsing the text content array.
function toolResult(extra: Record<string, unknown>, summary: string): Record<string, unknown> {
  return { content: [{ type: "text", text: summary }], ...extra };
}

// ── Project discovery (carried over from the legacy sidecar) ───────────────

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

function findProjectsRoot(): string {
  if (process.env.HYPERFRAMES_PROJECTS_DIR) {
    return process.env.HYPERFRAMES_PROJECTS_DIR;
  }
  let dir = dirname(process.execPath);
  for (let i = 0; i < 8; i++) {
    const candidate = resolve(dir, "ikenga-desktop", "hyperframes-projects");
    if (existsSync(candidate)) return candidate;
    const flat = resolve(dir, "hyperframes-projects");
    if (existsSync(flat)) return flat;
    dir = dirname(dir);
  }
  throw new Error(
    "could not locate hyperframes-projects/; set HYPERFRAMES_PROJECTS_DIR",
  );
}

function listProjects(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => {
      const p = resolve(root, name);
      try {
        return statSync(p).isDirectory() && !name.startsWith(".");
      } catch {
        return false;
      }
    })
    .sort();
}

// Create a temp dir of no-op browser-launcher shims and return its path.
// The HyperFrames CLI's `preview` command unconditionally calls the npm
// `open` package after the dev server binds, which on Linux shells out to
// `xdg-open` (and falls back to `gnome-open` / `kde-open`). With the sidecar
// hosting the iframe inside the desktop app, that opens an unwanted system
// browser tab. We fix it at the PATH layer rather than patching upstream.
let noBrowserShimDir: string | null = null;
function getNoBrowserShimDir(): string {
  if (noBrowserShimDir) return noBrowserShimDir;
  const dir = mkdtempSync(join(tmpdir(), "pa-hyperframes-shims-"));
  for (const name of ["xdg-open", "open", "gnome-open", "kde-open", "kde-open5"]) {
    const path = join(dir, name);
    writeFileSync(path, "#!/usr/bin/env sh\nexit 0\n");
    chmodSync(path, 0o755);
  }
  noBrowserShimDir = dir;
  return dir;
}

function findHyperframesBin(projectDir: string): string {
  if (process.env.HYPERFRAMES_BIN && existsSync(process.env.HYPERFRAMES_BIN)) {
    return process.env.HYPERFRAMES_BIN;
  }
  let real: string;
  try {
    real = realpathSync(projectDir);
  } catch {
    real = projectDir;
  }
  let dir = real;
  for (let i = 0; i < 6; i++) {
    const candidate = resolve(dir, "node_modules", ".bin", "hyperframes");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `could not locate hyperframes CLI for project ${projectDir} (real: ${real})`,
  );
}

// ── Per-slug preview state ─────────────────────────────────────────────────

interface Active {
  child: ChildProcess;
  project: string;
  port: number;
}

// Map slug → Active. Iteration order is insertion order, so the last entry
// is the most-recently-opened — used as the compat fallback for callers
// that don't pass a slug.
const actives = new Map<string, Active>();
let projectsRoot: string;

function lastActive(): Active | null {
  let last: Active | null = null;
  for (const a of actives.values()) last = a;
  return last;
}

async function openProject(slug: string): Promise<{ project: string; port: number }> {
  const existing = actives.get(slug);
  if (existing) {
    return { project: existing.project, port: existing.port };
  }
  if (actives.size >= MAX_ACTIVE_PROJECTS) {
    throw new Error(
      `max ${MAX_ACTIVE_PROJECTS} concurrent previews reached — close one before opening another`,
    );
  }

  const projectDir = resolve(projectsRoot, slug);
  if (!existsSync(projectDir)) {
    throw new Error(`project not found: ${slug}`);
  }

  const bin = findHyperframesBin(projectDir);
  const port = await findFreePort();

  log(`opening project=${slug} cwd=${projectDir} port=${port}`);

  const shimDir = getNoBrowserShimDir();
  const child = spawn(bin, ["preview", `--port=${port}`, "--force-new"], {
    cwd: projectDir,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      BROWSER: "none",
      // Shadow xdg-open / open / gnome-open with no-op shims so the HF CLI's
      // `import("open")` call resolves but does nothing.
      PATH: `${shimDir}:${process.env.PATH ?? ""}`,
    },
  });

  const entry: Active = { child, project: slug, port };
  actives.set(slug, entry);

  // Drop this entry from the map iff it's still the one we registered.
  // Guards against a late `exit` racing a different open of the same slug.
  const detach = () => {
    if (actives.get(slug) === entry) actives.delete(slug);
  };

  return new Promise((resolveReady, rejectReady) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const timer = setTimeout(() => {
      settle(() => {
        // Tear down the half-booted child; supervisor expectation is that a
        // failed open leaves no zombie preview server hanging on a port.
        try {
          child.kill("SIGTERM");
        } catch {
          // ignore
        }
        detach();
        rejectReady(new Error(`open_project timed out after ${OPEN_READY_TIMEOUT_MS}ms`));
      });
    }, OPEN_READY_TIMEOUT_MS);

    const onReady = () => {
      clearTimeout(timer);
      settle(() => resolveReady({ project: slug, port }));
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      process.stderr.write(`[hf:${slug}] ${text}`);
      if (!settled && (text.includes(`:${port}`) || /listening|ready|local:/i.test(text))) {
        onReady();
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(`[hf:${slug}] ${chunk.toString("utf8")}`);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      settle(() => {
        detach();
        rejectReady(new Error(`child process: ${err.message}`));
      });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      log(`project=${slug} exited code=${code}`);
      detach();
      // If we never readied, fail the open. If we already readied, the
      // active state is cleared and the next open_project will respawn.
      settle(() => {
        rejectReady(new Error(`hyperframes preview exited (code=${code}) before ready`));
      });
    });
  });
}

async function closeOne(slug: string): Promise<boolean> {
  const entry = actives.get(slug);
  if (!entry) return false;
  actives.delete(slug);
  try {
    entry.child.kill("SIGTERM");
  } catch {
    // ignore
  }
  await new Promise((r) => setTimeout(r, 800));
  if (!entry.child.killed) {
    try {
      entry.child.kill("SIGKILL");
    } catch {
      // ignore
    }
  }
  return true;
}

async function closeAll(): Promise<number> {
  const slugs = [...actives.keys()];
  let n = 0;
  for (const slug of slugs) {
    if (await closeOne(slug)) n++;
  }
  return n;
}

// ── MCP request dispatch ───────────────────────────────────────────────────

const TOOLS = [
  {
    name: "list_projects",
    description: "List bundled HyperFrames project slugs.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "open_project",
    description: "Boot the preview server for a project. Returns the bound 127.0.0.1 port.",
    inputSchema: {
      type: "object",
      properties: { slug: { type: "string", description: "Project slug from list_projects." } },
      required: ["slug"],
      additionalProperties: false,
    },
  },
  {
    name: "close_project",
    description:
      "Shut down a preview server. Pass `slug` to close one; pass `all: true` to close every active preview. With no args, closes the most-recently-opened (compat).",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Slug to close (optional)." },
        all: { type: "boolean", description: "Close every active preview." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_status",
    description:
      "Report `{project, port}` for a slug, or — when called with no args — the most-recently-opened preview (both null if idle).",
    inputSchema: {
      type: "object",
      properties: { slug: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "list_active",
    description: "Return every running preview server: `{actives: [{project, port}]}`.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

async function handleToolCall(
  name: string,
  args: Record<string, unknown> | undefined,
): Promise<Record<string, unknown>> {
  switch (name) {
    case "list_projects": {
      const projects = listProjects(projectsRoot);
      return toolResult({ projects }, `${projects.length} project(s)`);
    }
    case "open_project": {
      const slug = typeof args?.slug === "string" ? args.slug : "";
      if (!slug) throw new Error("open_project requires arguments.slug (string)");
      const { project, port } = await openProject(slug);
      return toolResult({ project, port }, `opened ${project} on :${port}`);
    }
    case "close_project": {
      const all = args?.all === true;
      const slug = typeof args?.slug === "string" ? args.slug : "";
      if (all) {
        const n = await closeAll();
        return toolResult({ closed: n > 0, count: n }, `closed ${n}`);
      }
      if (slug) {
        const ok = await closeOne(slug);
        return toolResult({ closed: ok, slug }, ok ? `closed ${slug}` : `${slug} not active`);
      }
      // Compat: no args → close the most-recently-opened.
      const last = lastActive();
      if (!last) return toolResult({ closed: false }, "no active project");
      const ok = await closeOne(last.project);
      return toolResult({ closed: ok, slug: last.project }, ok ? `closed ${last.project}` : "no-op");
    }
    case "get_status": {
      const slug = typeof args?.slug === "string" ? args.slug : "";
      const entry = slug ? actives.get(slug) ?? null : lastActive();
      const project = entry?.project ?? null;
      const port = entry?.port ?? null;
      return toolResult({ project, port }, project ? `${project}:${port}` : "idle");
    }
    case "list_active": {
      const list = [...actives.values()].map((a) => ({ project: a.project, port: a.port }));
      return toolResult({ actives: list }, `${list.length} active`);
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

async function dispatch(req: JsonRpcRequest): Promise<void> {
  // Notifications (no id) — never reply.
  const id = req.id ?? null;

  // TODO(Q3 auth): validate req.params._meta.royaltiAuth.token against the
  // sidecar's boot-time secret. Out of scope for v1.

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
      return; // notifications: no reply

    case "tools/list":
      reply(id, { tools: TOOLS });
      return;

    case "tools/call": {
      const params = (req.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
      const toolName = params.name;
      if (typeof toolName !== "string") {
        replyError(id, -32602, "tools/call missing params.name");
        return;
      }
      try {
        const result = await handleToolCall(toolName, params.arguments);
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
  try {
    projectsRoot = findProjectsRoot();
  } catch (e) {
    // Fatal — without a projects root we can't serve anything. Emit to
    // stderr and exit; supervisor's retry budget will surface it.
    log(`fatal: ${(e as Error).message}`);
    process.exit(1);
  }

  log(`projects root: ${projectsRoot}`);

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
      // Fire-and-forget: dispatch is async but ordering on a single stdin
      // doesn't matter — JSON-RPC ids let the caller correlate replies.
      void dispatch(req).catch((e) => {
        log(`dispatch crashed for method=${req.method}: ${(e as Error).message}`);
        replyError(req.id ?? null, -32603, `internal: ${(e as Error).message}`);
      });
    }
  });

  process.stdin.on("end", () => {
    log("stdin closed; shutting down");
    void closeAll().then(() => process.exit(0));
  });

  process.on("SIGTERM", () => {
    void closeAll().then(() => process.exit(0));
  });
  process.on("SIGINT", () => {
    void closeAll().then(() => process.exit(0));
  });
}

main().catch((e) => {
  log(`fatal: ${(e as Error).message}`);
  process.exit(1);
});
