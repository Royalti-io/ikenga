import { describe, expect, test } from "bun:test";
import { spawn } from "bun";
import path from "node:path";

const BINARY = path.resolve(import.meta.dir, "..", "dist", "ikenga-mbox-x86_64-unknown-linux-gnu");
const FIXTURE = path.resolve(import.meta.dir, "fixtures", "sample.mbox");

interface Frame {
  id: string;
  type: string;
  data?: unknown;
  error?: string;
  count?: number;
}

async function run(requests: Array<Record<string, unknown>>): Promise<Frame[]> {
  const proc = spawn([BINARY], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  for (const req of requests) {
    proc.stdin.write(JSON.stringify(req) + "\n");
  }
  proc.stdin.end();

  const stdout = await new Response(proc.stdout).text();
  await proc.exited;

  return stdout
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Frame);
}

describe("pa-mbox-sidecar", () => {
  test("ping returns pong + done", async () => {
    const frames = await run([{ id: "1", method: "ping" }]);
    expect(frames).toEqual([
      { id: "1", type: "pong" },
      { id: "1", type: "done", count: 0 },
    ]);
  });

  test("listMailboxes returns the configured keys", async () => {
    const frames = await run([{ id: "x", method: "listMailboxes" }]);
    expect(frames[0].type).toBe("mailboxes");
    expect(Array.isArray(frames[0].data)).toBe(true);
    expect((frames[0].data as string[]).length).toBeGreaterThan(0);
    expect(frames[1]).toEqual({ id: "x", type: "done", count: (frames[0].data as string[]).length });
  });

  test("readMboxFile parses fixture correctly", async () => {
    const frames = await run([
      {
        id: "r",
        method: "readMboxFile",
        params: {
          path: FIXTURE,
          inboxSource: "test",
          newestFirst: false,
          chunkSize: 10 * 1024 * 1024,
        },
      },
    ]);

    const emails = frames.filter((f) => f.type === "email").map((f) => f.data as Record<string, unknown>);
    const done = frames.find((f) => f.type === "done");

    expect(emails.length).toBe(4);
    expect(done?.count).toBe(4);

    // Plain
    expect(emails[0].message_id).toBe("plain-001@example.com");
    expect(emails[0].from_address).toBe("alice@example.com");
    expect(emails[0].subject).toBe("Plain text hello");
    expect((emails[0].body_text as string)).toContain("plain-text message");

    // MIME-encoded subject (B/base64) + quoted-printable body + In-Reply-To
    expect(emails[1].message_id).toBe("qp-002@example.com");
    expect(emails[1].in_reply_to).toBe("plain-001@example.com");
    expect((emails[1].subject as string)).toContain("Test email");
    expect((emails[1].body_text as string)).toContain("quoted-printable");
    expect((emails[1].body_text as string)).toContain("=");

    // Multipart -> picks text/plain part
    expect(emails[2].message_id).toBe("multi-003@example.com");
    expect((emails[2].body_text as string)).toContain("plain part");

    // Base64 body decoded
    expect(emails[3].message_id).toBe("b64-004@example.com");
    expect((emails[3].body_text as string)).toBe("Base64-encoded body text.");
  });

  test("invalid JSON request emits error frame", async () => {
    const frames = await run([{ id: "ok", method: "ping" }]);
    expect(frames[0].type).toBe("pong"); // sanity

    // Now send a deliberately malformed line
    const proc = spawn([BINARY], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    proc.stdin.write("not json\n");
    proc.stdin.end();
    const out = await new Response(proc.stdout).text();
    await proc.exited;

    const errFrames = out.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Frame);
    expect(errFrames[0].type).toBe("error");
    expect(errFrames[0].error).toContain("invalid JSON");
  });

  test("unknown method returns error", async () => {
    const frames = await run([{ id: "u", method: "doesNotExist" }]);
    expect(frames[0].type).toBe("error");
    expect((frames[0].error ?? "")).toContain("unknown method");
  });
});
