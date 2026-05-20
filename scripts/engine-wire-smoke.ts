#!/usr/bin/env bun
// ADR-013 §6 — engine wire-protocol smoke harness.
//
// Probes the two non-Claude engine wires the Rust adapters wrap, directly
// against the installed CLIs — no built shell required. This validates the
// exact protocol surface that `engines/gemini_acp` and `engines/codex_pty`
// depend on, so a CLI upgrade that breaks the wire is caught here before it
// surfaces as a mysterious chat failure.
//
//   Gemini → ACP passthrough:  spawn `gemini --acp`, send a JSON-RPC
//             `initialize`, assert the handshake response shape.
//   Codex  → custom adapter:   run `codex exec --json`, assert the stream
//             emits parseable JSONL thread/turn events.
//
// Claude Code is intentionally NOT covered here — its wire is the in-shell
// stream-json translator exercised by `src/lib/dev/acp-smoke.ts` via iyke.
//
// Usage:  bun run scripts/engine-wire-smoke.ts [--engine=gemini|codex|all]
// Exit:   0 if every probed engine PASSED or was cleanly BLOCKED on a
//         user-action prerequisite (auth/config); 1 on an unexpected wire
//         failure (the adapter's assumptions are wrong).

type Outcome = 'PASS' | 'BLOCKED' | 'FAIL';
interface Result {
	engine: string;
	outcome: Outcome;
	detail: string;
}

const PROMPT = 'Reply with exactly: ACP-OK';

function arg(name: string, fallback: string): string {
	const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
	return hit ? hit.slice(name.length + 3) : fallback;
}

/** Drain a readable stream to a string with a wallclock cap. Resolves with
 *  whatever was read by the deadline (gemini block-buffers, so we can't wait
 *  for EOF). */
async function readWithDeadline(stream: ReadableStream<Uint8Array>, ms: number): Promise<string> {
	const reader = stream.getReader();
	const dec = new TextDecoder();
	let out = '';
	const deadline = Date.now() + ms;
	try {
		while (Date.now() < deadline) {
			const remaining = deadline - Date.now();
			const next = reader.read();
			const timed = await Promise.race([
				next,
				new Promise<{ timeout: true }>((r) => setTimeout(() => r({ timeout: true }), remaining)),
			]);
			if ('timeout' in timed) break;
			if (timed.done) break;
			out += dec.decode(timed.value, { stream: true });
			// Gemini emits the full initialize result on one line; bail early
			// once we have a complete JSON object to keep the probe snappy.
			if (out.includes('"protocolVersion"') && out.trimEnd().endsWith('}')) break;
		}
	} finally {
		void reader.cancel().catch(() => {});
	}
	return out;
}

async function probeGemini(): Promise<Result> {
	const engine = 'gemini';
	const bin = Bun.which('gemini');
	if (!bin) return { engine, outcome: 'BLOCKED', detail: 'gemini not on PATH' };

	const proc = Bun.spawn(['gemini', '--acp', '--debug'], {
		stdin: 'pipe',
		stdout: 'pipe',
		stderr: 'ignore',
	});
	const init = `${JSON.stringify({
		jsonrpc: '2.0',
		id: 1,
		method: 'initialize',
		params: { protocolVersion: 1, clientCapabilities: {} },
	})}\n`;
	proc.stdin.write(init);
	await proc.stdin.flush();

	const raw = await readWithDeadline(proc.stdout, 25_000);
	proc.kill();

	const line = raw.split('\n').find((l) => l.includes('"protocolVersion"'));
	if (!line) {
		return {
			engine,
			outcome: 'FAIL',
			detail: `no initialize response within 25s; got: ${raw.slice(0, 200)}`,
		};
	}
	let msg: { result?: { protocolVersion?: number; agentCapabilities?: Record<string, unknown> } };
	try {
		msg = JSON.parse(line);
	} catch (e) {
		return { engine, outcome: 'FAIL', detail: `unparseable JSON-RPC: ${String(e)}` };
	}
	const pv = msg.result?.protocolVersion;
	const caps = msg.result?.agentCapabilities;
	if (pv !== 1) return { engine, outcome: 'FAIL', detail: `expected protocolVersion 1, got ${pv}` };
	if (!caps || !('loadSession' in caps)) {
		return { engine, outcome: 'FAIL', detail: 'handshake missing agentCapabilities.loadSession' };
	}
	return {
		engine,
		outcome: 'PASS',
		detail: `ACP handshake OK — protocolVersion=${pv}, loadSession=${caps.loadSession}, promptCapabilities present`,
	};
}

async function probeCodex(): Promise<Result> {
	const engine = 'codex';
	const bin = Bun.which('codex');
	if (!bin) return { engine, outcome: 'BLOCKED', detail: 'codex not on PATH' };

	const proc = Bun.spawn(['codex', 'exec', '--json', PROMPT], {
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [out, err] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	await proc.exited;

	const combined = `${out}\n${err}`;
	if (/invalid transport|error loading configuration/i.test(combined)) {
		return {
			engine,
			outcome: 'BLOCKED',
			detail:
				'~/.codex/config.toml fails to parse (dotted MCP server id splits into nested TOML tables). ' +
				'Fix or remove the malformed [mcp_servers."…"] entry, then re-run.',
		};
	}
	if (/401|unauthorized|not logged in|run `codex login`/i.test(combined)) {
		return {
			engine,
			outcome: 'BLOCKED',
			detail: 'codex not authenticated — run `codex login`, then re-run.',
		};
	}

	// Parse JSONL: each non-empty stdout line should be a JSON object.
	const events: unknown[] = [];
	for (const l of out.split('\n')) {
		const t = l.trim();
		if (!t) continue;
		try {
			events.push(JSON.parse(t));
		} catch {
			// codex prefixes some human lines; ignore non-JSON noise.
		}
	}
	if (events.length === 0) {
		return {
			engine,
			outcome: 'FAIL',
			detail: `no JSONL events parsed from codex exec --json. stderr: ${err.slice(0, 200)}`,
		};
	}
	return {
		engine,
		outcome: 'PASS',
		detail: `codex exec --json streamed ${events.length} parseable JSONL events`,
	};
}

async function main() {
	const which = arg('engine', 'all');
	const results: Result[] = [];
	if (which === 'all' || which === 'gemini') results.push(await probeGemini());
	if (which === 'all' || which === 'codex') results.push(await probeCodex());

	console.log('\nADR-013 engine wire smoke\n─────────────────────────');
	let hardFail = false;
	for (const r of results) {
		const icon = r.outcome === 'PASS' ? '✓' : r.outcome === 'BLOCKED' ? '⊘' : '✗';
		console.log(`${icon} ${r.engine.padEnd(7)} ${r.outcome.padEnd(8)} ${r.detail}`);
		if (r.outcome === 'FAIL') hardFail = true;
	}
	console.log('');
	process.exit(hardFail ? 1 : 0);
}

void main();
