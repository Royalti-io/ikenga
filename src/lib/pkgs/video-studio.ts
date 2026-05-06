// Video Studio pkg helpers — wrap `pkgMcpCall` for the supervised
// Remotion Studio sidecar. Throw on `ok: false`.

import { pkgMcpCall } from "@/lib/tauri-cmd";

export const VIDEO_STUDIO_PKG_ID = "com.royalti.video-studio";

export interface StudioStarted {
  port: number;
}

async function call(tool: string, args: unknown = {}): Promise<unknown> {
  const r = await pkgMcpCall(VIDEO_STUDIO_PKG_ID, tool, args);
  if (!r.ok) throw new Error(r.error ?? `${tool} failed`);
  return r.result;
}

export async function startStudio(): Promise<StudioStarted> {
  const result = (await call("start_studio")) as { port?: unknown };
  const port = typeof result?.port === "number" ? result.port : null;
  if (port === null) throw new Error(`start_studio: missing port`);
  return { port };
}

export async function stopStudio(): Promise<void> {
  await call("stop_studio");
}

export async function getStatus(): Promise<number | null> {
  const result = (await call("get_status")) as { port?: unknown };
  return typeof result?.port === "number" ? result.port : null;
}
