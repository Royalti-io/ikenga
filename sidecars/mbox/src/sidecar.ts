/**
 * pa-mbox-sidecar — line-delimited JSON-RPC over stdio.
 *
 * Wraps the vendored thunderbird-reader so the desktop app can read
 * Thunderbird mbox files without depending on ikenga being running.
 *
 * Protocol
 * --------
 *   Request:  {"id": string, "method": string, "params": object}\n
 *   Response: {"id": string, "type": "email"|"ids"|"pong"|"error"|"done", ...}\n
 *
 * Each request emits one or more frames terminated by a {type:"done"} frame.
 * stdout carries the protocol; stderr carries logs.
 */

import {
  readAllMailboxes,
  readMboxFile,
  readSentMessageIds,
  MAILBOX_MAP,
  type ParsedEmail,
} from "./thunderbird-reader";

// Keep console output off stdout — stdout is reserved for protocol frames.
const log = (...args: unknown[]) => {
  process.stderr.write(`[mbox-sidecar] ${args.map(String).join(" ")}\n`);
};
console.log = log;
console.warn = log;
console.error = log;

const DEFAULT_CHUNK_SIZE = 20 * 1024 * 1024; // 20 MB

type Frame =
  | { id: string; type: "email"; data: ParsedEmail }
  | { id: string; type: "ids"; data: string[] }
  | { id: string; type: "mailboxes"; data: string[] }
  | { id: string; type: "pong" }
  | { id: string; type: "error"; error: string }
  | { id: string; type: "done"; count: number };

function emit(frame: Frame): void {
  process.stdout.write(JSON.stringify(frame) + "\n");
}

interface RequestEnvelope {
  id?: string;
  method?: string;
  params?: Record<string, unknown>;
}

function parseSince(params: Record<string, unknown> | undefined): Date | undefined {
  const v = params?.sinceIso;
  if (typeof v !== "string" || v.length === 0) return undefined;
  const d = new Date(v);
  return isNaN(d.getTime()) ? undefined : d;
}

function parseChunkSize(params: Record<string, unknown> | undefined): number {
  const v = params?.chunkSize;
  return typeof v === "number" && v > 0 ? v : DEFAULT_CHUNK_SIZE;
}

function parseMailboxes(params: Record<string, unknown> | undefined): string[] | undefined {
  const v = params?.mailboxes;
  if (!Array.isArray(v)) return undefined;
  return v.filter((x): x is string => typeof x === "string");
}

async function handle(req: RequestEnvelope): Promise<void> {
  const id = req.id ?? "";
  const method = req.method ?? "";
  const params = req.params ?? {};

  try {
    switch (method) {
      case "ping": {
        emit({ id, type: "pong" });
        emit({ id, type: "done", count: 0 });
        return;
      }

      case "listMailboxes": {
        emit({ id, type: "mailboxes", data: Object.keys(MAILBOX_MAP) });
        emit({ id, type: "done", count: Object.keys(MAILBOX_MAP).length });
        return;
      }

      case "readAllMailboxes": {
        const emails = readAllMailboxes({
          chunkSize: parseChunkSize(params),
          sinceDate: parseSince(params),
          mailboxes: parseMailboxes(params),
        });
        for (const e of emails) emit({ id, type: "email", data: e });
        emit({ id, type: "done", count: emails.length });
        return;
      }

      case "readMboxFile": {
        const path = params.path;
        const inboxSource = params.inboxSource;
        const newestFirst = params.newestFirst;
        if (typeof path !== "string" || typeof inboxSource !== "string") {
          throw new Error("readMboxFile requires string params: path, inboxSource");
        }
        const emails = readMboxFile(path, inboxSource, {
          chunkSize: parseChunkSize(params),
          newestFirst: newestFirst === true,
          sinceDate: parseSince(params),
        });
        for (const e of emails) emit({ id, type: "email", data: e });
        emit({ id, type: "done", count: emails.length });
        return;
      }

      case "readSentMessageIds": {
        const ids = readSentMessageIds({
          chunkSize: parseChunkSize(params),
          sinceDate: parseSince(params),
        });
        const arr = Array.from(ids);
        emit({ id, type: "ids", data: arr });
        emit({ id, type: "done", count: arr.length });
        return;
      }

      default: {
        throw new Error(`unknown method: ${method}`);
      }
    }
  } catch (err) {
    emit({
      id,
      type: "error",
      error: err instanceof Error ? err.message : String(err),
    });
    emit({ id, type: "done", count: 0 });
  }
}

async function main(): Promise<void> {
  log(`started (pid=${process.pid}) — awaiting requests on stdin`);

  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true });

    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line.length === 0) continue;

      let req: RequestEnvelope;
      try {
        req = JSON.parse(line) as RequestEnvelope;
      } catch {
        emit({ id: "", type: "error", error: "invalid JSON request" });
        emit({ id: "", type: "done", count: 0 });
        continue;
      }

      await handle(req);
    }
  }

  log("stdin closed — exiting");
}

main().catch((err) => {
  log("fatal:", err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
