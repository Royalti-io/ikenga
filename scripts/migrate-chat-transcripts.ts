#!/usr/bin/env bun

//
// migrate-chat-transcripts — S-3 of
// plans/2026-07-18-transcripts-and-terminal-architecture/07-retire-the-overlay.md
//
// Moves the surviving pre-D-13 chat transcripts out of the per-session
// CLAUDE_CONFIG_DIR overlay and into the one true location claude's native
// discovery (and `claude --resume`) already reads:
//
//   ~/.cache/app.ikenga/sessions/<thread-id>/.claude/projects/<slug>/<session-id>.jsonl
//   -> ~/.claude/projects/<slug>/<session-id>.jsonl
//
// D-13 (07-retire-the-overlay.md) retired the overlay builder. S-1/S-4 are
// done and proven — the shell no longer sets CLAUDE_CONFIG_DIR and no longer
// builds the per-session directory. This script is the one-shot cleanup that
// lets S-2 (dropping the overlay-walk fallback in
// `commands/claude.rs::jsonl_projects_roots`) happen safely afterward: that
// walk deliberately stays in the code today specifically so pre-D-13
// transcripts remain findable until this migration has run. See the comment
// on `jsonl_projects_roots` for the paired half of this contract.
//
// ── SEQUENCING — READ BEFORE RUNNING ────────────────────────────────────────
//
// `scripts/backfill-claude-session-ids.ts` MUST run (with --apply) BEFORE
// this script is ever run with --apply. That script fills
// `chat_sessions.claude_session_id` for threads whose overlay transcript
// exists but whose DB row never learned the session id — it does this by
// scanning the SAME overlay paths this script is about to move files out of.
// If this script moves the files first, the backfill scan finds nothing
// under the overlay and those threads' claude_session_id stays NULL forever
// (the transcript itself is not lost — it lands correctly under
// ~/.claude/projects — but the thread can never be linked back to it from
// the chat UI).
//
// Correct order:
//   1. bun run scripts/backfill-claude-session-ids.ts --apply
//   2. bun run scripts/migrate-chat-transcripts.ts --apply
//
// These are NOT folded into one script on purpose: backfill writes to
// ikenga.db (a locked SQLite file the running shell may hold open) and this
// script writes to the filesystem (renames/copies that must survive a crash
// mid-run without corrupting either copy). Different failure modes,
// different retry stories — keeping them separate keeps each one simple and
// independently re-runnable.
//
// This script REFUSES TO RUN — in both dry-run and --apply — while any
// chat_sessions row has claude_session_id IS NULL *and* a matching
// transcript still sits under the overlay (i.e. exactly the set the backfill
// script above would resolve). That is the ordering hazard stated above,
// enforced in code instead of left as a doc the founder has to remember.
// Dry-run refuses too, deliberately: a dry run that reported "safe to
// migrate" while the gate would in fact block --apply would be a script that
// lies about its own behavior.
//
// Usage:
//   bun run scripts/migrate-chat-transcripts.ts            # dry run (default)
//   bun run scripts/migrate-chat-transcripts.ts --apply    # actually move
//
// Safety:
//   - Dry run by default. Nothing is written or moved unless --apply is passed.
//   - NEVER overwrites an existing destination file. Skip and report instead.
//   - Before any source is unlinked, source and destination bytes are
//     confirmed identical by hash (sha256, streamed). Same-device moves use
//     a single atomic rename (no separate unlink — nothing to verify against,
//     the OS move is the atomic step); cross-device moves copy, hash-verify
//     the copy against the source, then unlink the source only on match.
//   - Idempotent: once a file has been moved, its source path no longer
//     exists, so a second run finds nothing to do for it.
//   - Refuses to run (exit 1) if the source overlay root itself is missing,
//     rather than reporting "0 found, done" over what could be a broken path.

import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import {
	copyFileSync,
	createReadStream,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	statSync,
	unlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// ── paths ────────────────────────────────────────────────────────────────

// Same resolution rules as backfill-claude-session-ids.ts — kept in sync
// deliberately, not imported, so each script stays a single self-contained
// file that can be read and trusted in isolation.
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

function resolveClaudeProjectsRoot(): string {
	const override = process.env.CLAUDE_PROJECTS_ROOT;
	if (override) return override;
	return join(homedir(), '.claude', 'projects');
}

// ── overlay scan ─────────────────────────────────────────────────────────

interface FoundTranscript {
	threadId: string;
	slug: string;
	sessionId: string;
	sourcePath: string;
	bytes: number;
}

/** Walk every <sessionsRoot>/<thread-id>/.claude/projects/<slug>/<session-id>.jsonl. */
function scanOverlay(sessionsRoot: string): FoundTranscript[] {
	const found: FoundTranscript[] = [];
	let threadDirs: string[];
	try {
		threadDirs = readdirSync(sessionsRoot, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => e.name);
	} catch (err) {
		throw new Error(
			`could not list ${sessionsRoot}: ${err instanceof Error ? err.message : String(err)}`
		);
	}

	for (const threadId of threadDirs) {
		const projectsDir = join(sessionsRoot, threadId, '.claude', 'projects');
		if (!existsSync(projectsDir)) continue;
		let slugDirs: string[];
		try {
			slugDirs = readdirSync(projectsDir, { withFileTypes: true })
				.filter((e) => e.isDirectory())
				.map((e) => e.name);
		} catch {
			continue;
		}
		for (const slug of slugDirs) {
			const slugPath = join(projectsDir, slug);
			let files: string[];
			try {
				files = readdirSync(slugPath, { withFileTypes: true })
					.filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
					.map((e) => e.name);
			} catch {
				continue;
			}
			for (const name of files) {
				const sourcePath = join(slugPath, name);
				const sessionId = name.slice(0, -'.jsonl'.length);
				let bytes = 0;
				try {
					bytes = statSync(sourcePath).size;
				} catch {
					continue;
				}
				found.push({ threadId, slug, sessionId, sourcePath, bytes });
			}
		}
	}
	return found;
}

// ── hashing ──────────────────────────────────────────────────────────────

function hashFile(path: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = createHash('sha256');
		const stream = createReadStream(path);
		stream.on('data', (chunk) => hash.update(chunk));
		stream.on('error', reject);
		stream.on('end', () => resolve(hash.digest('hex')));
	});
}

// ── device check ─────────────────────────────────────────────────────────

/** Nearest existing ancestor of `p` — used to determine device before the
 * destination directory necessarily exists yet. */
function nearestExistingAncestor(p: string): string {
	let cur = p;
	while (!existsSync(cur)) {
		const parent = dirname(cur);
		if (parent === cur) return cur; // hit filesystem root
		cur = parent;
	}
	return cur;
}

function sameDevice(a: string, b: string): boolean {
	const devA = statSync(nearestExistingAncestor(a)).dev;
	const devB = statSync(nearestExistingAncestor(b)).dev;
	return devA === devB;
}

// ── DB gate ──────────────────────────────────────────────────────────────

/** Rows the backfill script would still fix: NULL claude_session_id whose
 * thread has a transcript sitting in the overlay right now. Moving those
 * transcripts before backfill runs strands the link permanently. */
function findUnlinkedBlockers(dbPath: string, found: FoundTranscript[]): string[] {
	const db = new Database(dbPath, { readonly: true });
	let nullIds: Set<string>;
	try {
		const rows = db.query(`SELECT id FROM chat_sessions WHERE claude_session_id IS NULL`).all() as {
			id: string;
		}[];
		nullIds = new Set(rows.map((r) => r.id));
	} finally {
		db.close();
	}
	const blockers = new Set<string>();
	for (const f of found) {
		if (nullIds.has(f.threadId)) blockers.add(f.threadId);
	}
	return [...blockers];
}

// ── main ─────────────────────────────────────────────────────────────────

type Action =
	| { kind: 'moved-rename' }
	| { kind: 'moved-copy-verify' }
	| { kind: 'would-move-rename' }
	| { kind: 'would-move-copy-verify' }
	| { kind: 'skip-dest-exists-identical' }
	| { kind: 'skip-dest-exists-different'; note: string }
	| { kind: 'error'; note: string };

/** Effective transcript retention. `null` means unset -> claude's 30-day default. */
function readCleanupPeriodDays(): number | null {
	for (const rel of [['.claude', 'settings.json'], ['.claude.json']]) {
		const f = join(homedir(), ...rel);
		if (!existsSync(f)) continue;
		try {
			const v = JSON.parse(readFileSync(f, 'utf8'))?.cleanupPeriodDays;
			if (typeof v === 'number') return v;
		} catch {
			/* unparseable — treat as unset */
		}
	}
	return null;
}

/** Overlay transcripts already older than `days`, newest-first by age. */
function collectOlderThan(root: string, days: number): Array<{ file: string; ageDays: number }> {
	const cutoff = Date.now() - days * 86_400_000;
	const out: Array<{ file: string; ageDays: number }> = [];
	for (const t of scanOverlay(root)) {
		const mtime = statSync(t.sourcePath).mtimeMs;
		if (mtime < cutoff) {
			out.push({ file: t.sourcePath, ageDays: Math.floor((Date.now() - mtime) / 86_400_000) });
		}
	}
	return out.sort((a, b) => b.ageDays - a.ageDays);
}

async function main() {
	const args = process.argv.slice(2);
	const apply = args.includes('--apply');

	const dbPath = resolveDbPath();
	const sessionsRoot = resolveSessionsRoot();
	const claudeProjectsRoot = resolveClaudeProjectsRoot();

	console.log(`DB:                   ${dbPath}`);
	console.log(`Sessions overlay root: ${sessionsRoot}`);
	console.log(`Destination root:      ${claudeProjectsRoot}`);
	console.log(`Mode:                  ${apply ? 'APPLY (writing)' : 'DRY RUN (no writes)'}`);
	console.log('');

	// ── Retention gate ────────────────────────────────────────────────────
	// The overlay has been SHELTERING old transcripts. `~/.claude/projects` is
	// swept by claude's own cleanup at `cleanupPeriodDays` (default 30). This
	// is not theoretical: at the time of writing, 0 of 2143 transcripts under
	// that root were older than 30 days on a machine in continuous use since
	// May — the sweep is demonstrably live.
	//
	// 15 of the 19 overlay transcripts are 50-66 days old. Moving them into a
	// 30-day-swept directory means they are reaped on the next claude
	// invocation: this script would destroy exactly the history it exists to
	// preserve. So refuse to move any file already older than the effective
	// retention window unless the operator has explicitly accepted that.
	const retentionDays = readCleanupPeriodDays(); // null => claude's 30-day default
	const effectiveRetention = retentionDays ?? 30;
	const doomed = collectOlderThan(sessionsRoot, effectiveRetention);
	if (doomed.length > 0 && !args.includes('--i-accept-reaping-old-transcripts')) {
		console.error(
			`error: ${doomed.length} transcript(s) are older than the effective retention window ` +
				`(${effectiveRetention} days${retentionDays === null ? ', claude’s default — cleanupPeriodDays is UNSET' : ''}).`
		);
		console.error('');
		console.error('Moving them into ~/.claude/projects would expose them to claude’s cleanup');
		console.error('sweep, which would delete them on the next invocation. The overlay has been');
		console.error('sheltering them; this migration removes that shelter.');
		console.error('');
		console.error('Oldest affected:');
		for (const d of doomed.slice(0, 5)) console.error(`  ${d.ageDays}d  ${d.file}`);
		if (doomed.length > 5) console.error(`  … and ${doomed.length - 5} more`);
		console.error('');
		console.error('Resolve by EITHER:');
		console.error('  a) setting cleanupPeriodDays in ~/.claude/settings.json to a horizon that');
		console.error('     covers them (this also protects your terminal + cron history, which is');
		console.error('     currently aging out at 30 days), then re-run; OR');
		console.error('  b) re-running with --i-accept-reaping-old-transcripts if you genuinely do');
		console.error('     not want these kept.');
		process.exit(1);
	}

	if (!existsSync(sessionsRoot)) {
		console.error(`error: source overlay root not found at ${sessionsRoot}.`);
		console.error(
			'Refusing to run — reporting "nothing to do" over a missing root would be a false'
		);
		console.error('positive, not a real "already migrated" state.');
		console.error('Set PA_SESSIONS_ROOT to override the path if this is wrong.');
		process.exit(1);
	}
	if (!existsSync(dbPath)) {
		console.error(
			`error: DB not found at ${dbPath}. Cannot check the ordering gate. Refusing to run.`
		);
		console.error('Set PA_DB_PATH to override the path if this is wrong.');
		process.exit(1);
	}

	const found = scanOverlay(sessionsRoot);
	console.log(`Found ${found.length} transcript(s) under the overlay.`);
	console.log('');

	// ── ordering gate ──────────────────────────────────────────────────────
	const blockers = findUnlinkedBlockers(dbPath, found);
	if (blockers.length > 0) {
		console.error('REFUSING TO RUN — ordering hazard.');
		console.error('');
		console.error(
			`${blockers.length} thread(s) have claude_session_id IS NULL in chat_sessions AND a transcript`
		);
		console.error(
			'still under the overlay. backfill-claude-session-ids.ts resolves exactly this set by'
		);
		console.error('scanning the overlay this script is about to empty. Run it first:');
		console.error('');
		console.error('  bun run scripts/backfill-claude-session-ids.ts --apply');
		console.error('');
		console.error('then re-run this script. Affected thread ids:');
		for (const id of blockers) console.error(`  ${id}`);
		process.exit(1);
	}
	console.log(
		'Ordering gate: PASS — no NULL claude_session_id row is blocked on an overlay transcript.'
	);
	console.log('');

	if (found.length === 0) {
		console.log(
			'Nothing to migrate. Idempotent: this is the expected steady state after a prior --apply run.'
		);
		return;
	}

	const results: (FoundTranscript & { action: Action })[] = [];

	for (const f of found) {
		const destDir = join(claudeProjectsRoot, f.slug);
		const destPath = join(destDir, `${f.sessionId}.jsonl`);

		if (existsSync(destPath)) {
			// NEVER overwrite. Skip and report — but tell the founder whether the
			// existing destination is actually the same content (safe to later
			// remove the source by hand) or genuinely different (needs a human).
			try {
				const [hSrc, hDst] = await Promise.all([hashFile(f.sourcePath), hashFile(destPath)]);
				if (hSrc === hDst) {
					results.push({ ...f, action: { kind: 'skip-dest-exists-identical' } });
				} else {
					results.push({
						...f,
						action: {
							kind: 'skip-dest-exists-different',
							note: `source sha256 ${hSrc.slice(0, 12)}… != dest sha256 ${hDst.slice(0, 12)}…`,
						},
					});
				}
			} catch (err) {
				results.push({
					...f,
					action: {
						kind: 'error',
						note: `hash compare failed: ${err instanceof Error ? err.message : String(err)}`,
					},
				});
			}
			continue;
		}

		const willBeSameDevice = sameDevice(f.sourcePath, claudeProjectsRoot);

		if (!apply) {
			results.push({
				...f,
				action: { kind: willBeSameDevice ? 'would-move-rename' : 'would-move-copy-verify' },
			});
			continue;
		}

		// ── apply ──────────────────────────────────────────────────────────
		try {
			mkdirSync(destDir, { recursive: true });

			if (willBeSameDevice) {
				// Atomic move. No separate unlink step exists to verify against —
				// the rename IS the atomic operation; there is never a moment with
				// two copies to compare.
				renameSync(f.sourcePath, destPath);
				results.push({ ...f, action: { kind: 'moved-rename' } });
			} else {
				// Cross-device: copy, hash-verify against the source, unlink the
				// source ONLY on a confirmed match.
				copyFileSync(f.sourcePath, destPath); // no COPYFILE_EXCL flag exposed by node fs sync API; existsSync check above already guards this
				const [hSrc, hDst] = await Promise.all([hashFile(f.sourcePath), hashFile(destPath)]);
				if (hSrc !== hDst) {
					results.push({
						...f,
						action: {
							kind: 'error',
							note: `post-copy hash mismatch (src ${hSrc.slice(0, 12)}… dst ${hDst.slice(0, 12)}…) — source NOT unlinked, destination left in place for inspection`,
						},
					});
					continue;
				}
				unlinkSync(f.sourcePath);
				results.push({ ...f, action: { kind: 'moved-copy-verify' } });
			}
		} catch (err) {
			results.push({
				...f,
				action: { kind: 'error', note: err instanceof Error ? err.message : String(err) },
			});
		}
	}

	// ── report ───────────────────────────────────────────────────────────
	console.log('── Per-file report ──────────────────────────────────────');
	for (const r of results) {
		console.log(`  thread ${r.threadId}`);
		console.log(`    session: ${r.sessionId}  slug: ${r.slug}  bytes: ${r.bytes}`);
		console.log(`    source:  ${r.sourcePath}`);
		console.log(`    dest:    ${join(claudeProjectsRoot, r.slug, `${r.sessionId}.jsonl`)}`);
		console.log(`    action:  ${r.action.kind}`);
		if ('note' in r.action) console.log(`    note:    ${r.action.note}`);
		console.log('');
	}

	const counts: Record<string, number> = {};
	for (const r of results) counts[r.action.kind] = (counts[r.action.kind] ?? 0) + 1;

	console.log('── Summary ──────────────────────────────────────────────');
	console.log(`  found:   ${found.length}`);
	for (const [kind, n] of Object.entries(counts)) console.log(`  ${kind}: ${n}`);
	if (!apply) {
		console.log('');
		console.log(
			'This was a DRY RUN. No files were moved, copied, or deleted. Re-run with --apply to write.'
		);
	}

	const hadErrors = results.some((r) => r.action.kind === 'error');
	if (hadErrors) process.exitCode = 1;
}

main();
