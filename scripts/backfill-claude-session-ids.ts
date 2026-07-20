#!/usr/bin/env bun
//
// backfill-claude-session-ids — recover chat_sessions rows whose
// claude_session_id is NULL but a real .jsonl transcript already exists
// on disk in that thread's own overlay folder.
//
// Root cause (see plans/2026-07-18-transcripts-and-terminal-architecture/
// 01-plan.md + 03-research-internal.md): src/chat/hooks.ts:226 only reads
// the JSONL "if (claudeId)" — a NULL claude_session_id means the thread's
// transcript is never looked up, even though `claude` already wrote it.
//
// The mapping is deterministic, NOT heuristic:
//
//   ~/.cache/app.ikenga/sessions/<thread-id>/.claude/projects/<slug>/<session-id>.jsonl
//   -> chat_sessions.id = <thread-id>, claude_session_id should be <session-id>
//
// Usage:
//   bun run scripts/backfill-claude-session-ids.ts            # dry run (default)
//   bun run scripts/backfill-claude-session-ids.ts --apply    # actually write
//
// Safety:
//   - Dry run by default. Nothing is written unless --apply is passed.
//   - Only ever fills a NULL claude_session_id. Never overwrites a non-null value.
//   - If a thread's overlay folder contains more than one .jsonl across all
//     project-slug dirs, that thread is SKIPPED and reported — no guessing.
//   - Refuses to run if the DB file doesn't exist (never creates one).

import { Database } from 'bun:sqlite';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ── paths ──────────────────────────────────────────────────────────────────

// NOTE: this intentionally diverges from scripts/pa-db.ts. pa-db.ts falls back
// to the legacy pa.db path when ikenga.db is absent; this script does not.
// ikenga.db is the canonical DB and a stale AppImage is known to write to
// pa.db instead — silently falling back to pa.db here would risk writing
// claude_session_id backfills into the wrong (stale) database. Refusing to
// run when ikenga.db isn't found is the correct behavior for this script.
function resolveDbPath(): string {
	const override = process.env.PA_DB_PATH;
	if (override) return override;
	const platform = process.platform;
	let base: string;
	if (platform === 'darwin') {
		base = join(homedir(), 'Library', 'Application Support', 'app.ikenga');
	} else if (platform === 'win32') {
		base = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'app.ikenga');
	} else {
		base = join(homedir(), '.local', 'share', 'app.ikenga');
	}
	return join(base, 'ikenga.db');
}

function resolveSessionsRoot(): string {
	const override = process.env.PA_SESSIONS_ROOT;
	if (override) return override;
	const platform = process.platform;
	if (platform === 'darwin') {
		return join(homedir(), 'Library', 'Caches', 'app.ikenga', 'sessions');
	}
	if (platform === 'win32') {
		return join(
			process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'),
			'app.ikenga',
			'sessions'
		);
	}
	return join(homedir(), '.cache', 'app.ikenga', 'sessions');
}

// ── overlay scan ──────────────────────────────────────────────────────────

/** Find every *.jsonl file under <sessionsRoot>/<threadId>/.claude/projects/**. */
function findTranscriptsForThread(sessionsRoot: string, threadId: string): string[] {
	const projectsDir = join(sessionsRoot, threadId, '.claude', 'projects');
	if (!existsSync(projectsDir)) return [];
	const found: string[] = [];
	let slugDirs: string[];
	try {
		slugDirs = readdirSync(projectsDir, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => e.name);
	} catch {
		return [];
	}
	for (const slug of slugDirs) {
		const slugPath = join(projectsDir, slug);
		let entries: string[];
		try {
			entries = readdirSync(slugPath, { withFileTypes: true })
				.filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
				.map((e) => e.name);
		} catch {
			continue;
		}
		for (const name of entries) {
			found.push(join(slugPath, name));
		}
	}
	return found;
}

function sessionIdFromJsonlPath(p: string): string {
	const base = p.slice(p.lastIndexOf('/') + 1);
	return base.endsWith('.jsonl') ? base.slice(0, -'.jsonl'.length) : base;
}

// ── main ──────────────────────────────────────────────────────────────────

interface ChatSessionRow {
	id: string;
	claude_session_id: string | null;
}

interface Outcome {
	threadId: string;
	kind: 'matched' | 'skipped';
	reason?: string;
	sessionId?: string;
	jsonlPath?: string;
}

function main() {
	const args = process.argv.slice(2);
	const apply = args.includes('--apply');

	const dbPath = resolveDbPath();
	if (!existsSync(dbPath)) {
		console.error(`error: DB not found at ${dbPath}. Refusing to run (will not create one).`);
		console.error(`Set PA_DB_PATH to override the path if this is wrong.`);
		process.exit(1);
	}

	const sessionsRoot = resolveSessionsRoot();
	if (!existsSync(sessionsRoot)) {
		console.error(`error: sessions overlay root not found at ${sessionsRoot}.`);
		console.error(`Set PA_SESSIONS_ROOT to override the path if this is wrong.`);
		process.exit(1);
	}

	console.log(`DB:              ${dbPath}`);
	console.log(`Sessions root:   ${sessionsRoot}`);
	console.log(`Mode:            ${apply ? 'APPLY (writing)' : 'DRY RUN (no writes)'}`);
	console.log('');

	// Open readonly first regardless of mode, to select the NULL rows.
	const roDb = new Database(dbPath, { readonly: true });
	let nullRows: ChatSessionRow[];
	try {
		nullRows = roDb
			.query(`SELECT id, claude_session_id FROM chat_sessions WHERE claude_session_id IS NULL`)
			.all() as ChatSessionRow[];
	} finally {
		roDb.close();
	}

	const outcomes: Outcome[] = [];
	let scanned = 0;

	for (const row of nullRows) {
		scanned++;
		const threadId = row.id;
		const jsonls = findTranscriptsForThread(sessionsRoot, threadId);

		if (jsonls.length === 0) {
			outcomes.push({ threadId, kind: 'skipped', reason: 'no .jsonl found under overlay' });
			continue;
		}
		if (jsonls.length > 1) {
			outcomes.push({
				threadId,
				kind: 'skipped',
				reason: `${jsonls.length} .jsonl files found (ambiguous) — ${jsonls
					.map((p) => sessionIdFromJsonlPath(p))
					.join(', ')}`,
			});
			continue;
		}

		const jsonlPath = jsonls[0]!;
		const sessionId = sessionIdFromJsonlPath(jsonlPath);
		if (!sessionId) {
			outcomes.push({ threadId, kind: 'skipped', reason: `could not parse session id from ${jsonlPath}` });
			continue;
		}
		// Sanity: file must actually be a regular file with content.
		try {
			const st = statSync(jsonlPath);
			if (!st.isFile() || st.size === 0) {
				outcomes.push({ threadId, kind: 'skipped', reason: `${jsonlPath} is empty or not a file` });
				continue;
			}
		} catch (err) {
			outcomes.push({
				threadId,
				kind: 'skipped',
				reason: `could not stat ${jsonlPath}: ${err instanceof Error ? err.message : String(err)}`,
			});
			continue;
		}

		outcomes.push({ threadId, kind: 'matched', sessionId, jsonlPath });
	}

	const matched = outcomes.filter((o) => o.kind === 'matched');
	const skipped = outcomes.filter((o) => o.kind === 'skipped');

	// Report matched
	if (matched.length > 0) {
		console.log(`${apply ? 'Updating' : 'Would update'} ${matched.length} row(s):`);
		for (const m of matched) {
			console.log(`  thread ${m.threadId}`);
			console.log(`    claude_session_id: NULL -> ${m.sessionId}`);
			console.log(`    source: ${m.jsonlPath}`);
		}
		console.log('');
	}

	if (skipped.length > 0) {
		console.log(`Skipped ${skipped.length} row(s):`);
		for (const s of skipped) {
			console.log(`  thread ${s.threadId}: ${s.reason}`);
		}
		console.log('');
	}

	let updated = 0;
	if (apply && matched.length > 0) {
		// NOTE: must be `{ readwrite: true }`, NOT `{ readonly: false }`.
		// bun:sqlite (1.3.6) derives its sqlite3_open_v2 flags from the truthy
		// keys present; an options object with no truthy readonly/readwrite/
		// create yields empty flags and throws SQLITE_MISUSE ("bad parameter or
		// other API misuse"). Verified by execution: `{readonly:false}` and `{}`
		// both throw; `undefined`, `{readwrite:true}` and `{readonly:true}` all
		// open successfully.
		const rwDb = new Database(dbPath, { readwrite: true });
		// Give SQLite a grace window to wait out a writer lock (e.g. the shell
		// itself has ikenga.db open) instead of failing immediately with
		// SQLITE_BUSY. Without this, running --apply while the shell is
		// running can abort the transaction with no partial write (safe) but
		// an unexplained-looking crash.
		rwDb.exec('PRAGMA busy_timeout = 5000');
		try {
			const stmt = rwDb.prepare(
				`UPDATE chat_sessions SET claude_session_id = ?, updated_at = ?
				   WHERE id = ? AND claude_session_id IS NULL`
			);
			const now = Date.now();
			const txn = rwDb.transaction((rows: Outcome[]) => {
				for (const m of rows) {
					const res = stmt.run(m.sessionId!, now, m.threadId);
					if (res.changes > 0) updated++;
				}
			});
			txn(matched);
		} catch (err) {
			// bun:sqlite surfaces lock contention as `err.code === 'SQLITE_BUSY'`
			// while `err.message` is the bare sqlite text "database is locked" —
			// matching on the message alone never fires. Check the code first and
			// keep the message test only as a fallback.
			const code = (err as { code?: string } | null)?.code;
			const msg = err instanceof Error ? err.message : String(err);
			if (code === 'SQLITE_BUSY' || /database is locked|SQLITE_BUSY/i.test(msg)) {
				console.error('');
				console.error(
					'error: could not write to ikenga.db — it is locked by another process (likely the running Ikenga shell).'
				);
				console.error('Close the shell and re-run this script with --apply.');
				// Close before exiting — `process.exit` inside the try would skip
				// the `finally` and leak the handle.
				rwDb.close();
				process.exit(1);
			}
			throw err;
		} finally {
			// Idempotent in bun:sqlite, so the early-exit close above is safe.
			rwDb.close();
		}
	}

	console.log('── Summary ──────────────────────────────────────────────');
	console.log(`  scanned (NULL claude_session_id rows): ${scanned}`);
	console.log(`  matched (single unambiguous .jsonl):   ${matched.length}`);
	if (apply) {
		console.log(`  updated (rows actually written):       ${updated}`);
	} else {
		console.log(`  would-update (run with --apply to write): ${matched.length}`);
	}
	console.log(`  skipped (with reason):                 ${skipped.length}`);
	if (!apply) {
		console.log('');
		console.log('This was a DRY RUN. No changes were written. Re-run with --apply to write.');
	}
}

main();
