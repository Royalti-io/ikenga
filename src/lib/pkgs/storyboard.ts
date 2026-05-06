// Storyboard pkg helpers — wrap `pkgMcpCall` for the supervised
// storyboard-app (Vite + Express) sidecar. Throw on `ok: false`.

import { pkgMcpCall } from "@/lib/tauri-cmd";

export const STORYBOARD_PKG_ID = "com.royalti.storyboard";

export interface StoryboardStarted {
  port: number;
}

async function call(tool: string, args: unknown = {}): Promise<unknown> {
  const r = await pkgMcpCall(STORYBOARD_PKG_ID, tool, args);
  if (!r.ok) throw new Error(r.error ?? `${tool} failed`);
  return r.result;
}

export async function startStoryboard(): Promise<StoryboardStarted> {
  const result = (await call("start_storyboard")) as { port?: unknown };
  const port = typeof result?.port === "number" ? result.port : null;
  if (port === null) throw new Error(`start_storyboard: missing port`);
  return { port };
}

export async function stopStoryboard(): Promise<void> {
  await call("stop_storyboard");
}

export async function getStatus(): Promise<number | null> {
  const result = (await call("get_status")) as { port?: unknown };
  return typeof result?.port === "number" ? result.port : null;
}
