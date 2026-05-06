// HyperFrames pkg helpers — thin wrappers around `pkgMcpCall` that unwrap
// the standardized `{ ok, error, result }` envelope and parse the tool
// result shapes. Throw on `ok: false` to mirror the prior shim behaviour
// (the FE useHyperframes hook + PaActions pattern both expect throws).

import { pkgMcpCall } from "@/lib/tauri-cmd";

export const HYPERFRAMES_PKG_ID = "com.royalti.hyperframes";

export interface HyperframesStarted {
  port: number;
  project: string;
}

async function call(tool: string, args: unknown = {}): Promise<unknown> {
  const r = await pkgMcpCall(HYPERFRAMES_PKG_ID, tool, args);
  if (!r.ok) throw new Error(r.error ?? `${tool} failed`);
  return r.result;
}

export async function listProjects(): Promise<string[]> {
  const result = (await call("list_projects")) as { projects?: unknown };
  const arr = result?.projects;
  if (!Array.isArray(arr)) throw new Error(`list_projects: missing projects[]`);
  return arr.map((v) => {
    if (typeof v !== "string") throw new Error(`list_projects: non-string entry`);
    return v;
  });
}

export async function openProject(slug: string): Promise<HyperframesStarted> {
  const result = (await call("open_project", { slug })) as {
    port?: unknown;
    project?: unknown;
  };
  const port = typeof result?.port === "number" ? result.port : null;
  if (port === null) throw new Error(`open_project: missing port`);
  const project = typeof result?.project === "string" ? result.project : slug;
  return { port, project };
}

export async function closeProject(slug?: string | null): Promise<void> {
  await call("close_project", slug ? { slug } : {});
}

export async function getStatus(): Promise<HyperframesStarted | null> {
  const result = (await call("get_status")) as {
    port?: unknown;
    project?: unknown;
  };
  const port = typeof result?.port === "number" ? result.port : null;
  const project = typeof result?.project === "string" ? result.project : null;
  if (port === null || project === null) return null;
  return { port, project };
}

export async function listActive(): Promise<HyperframesStarted[]> {
  const result = (await call("list_active")) as { actives?: unknown };
  const arr = result?.actives;
  if (!Array.isArray(arr)) throw new Error(`list_active: missing actives[]`);
  return arr.map((v) => {
    const obj = v as { project?: unknown; port?: unknown };
    if (typeof obj?.project !== "string" || typeof obj?.port !== "number") {
      throw new Error(`list_active: malformed entry`);
    }
    return { project: obj.project, port: obj.port };
  });
}
