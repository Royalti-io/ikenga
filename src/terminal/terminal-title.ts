/**
 * terminal-title — how a terminal names itself across every surface: pane tab
 * strips, dock tabs, the detached pop-out header + its OS window title, and the
 * `iyke state` pane summary agents read.
 *
 * Before this, a terminal tab read the constant string "Terminal" — six of them
 * open meant six identical tabs. The label answers two questions instead:
 *
 *     claude · shell          what's running  ·  where
 *     bash · ikenga
 *     vim · royalti-co (scout)                    ^ agent-assigned name
 *
 * The "what" is LIVE: it comes from the PTY's foreground process group
 * (`TerminalDescriptor.foreground_command`), so a tab that starts as
 * `bash · shell` becomes `claude · shell` the moment you launch claude, and
 * goes back when you quit. It falls back to the spawn-time title, then to the
 * argv, so a terminal still names itself sensibly on platforms that can't
 * observe the foreground process and during the gap before the first poll.
 *
 * This module is deliberately pure — no store reads, no IPC, no `Date.now()`.
 * The React side lives in `use-terminal-titles.ts`.
 */

/** Shells that are "just a prompt" rather than a task. Kept only so the
 *  tooltip can say `at a prompt` — the label still shows the shell name,
 *  because "bash · shell" is honest and distinguishes an idle terminal from
 *  one that's busy. */
const SHELL_NAMES = new Set(['bash', 'zsh', 'sh', 'fish', 'dash', 'ksh', 'nu', 'pwsh', 'csh']);

export interface TerminalTitleInput {
	/** Working directory the PTY was spawned in. */
	cwd?: string | null;
	/** Spawn argv — `['bash', '-l']`, `['claude']`. */
	argv?: string[] | null;
	/** Title chosen at spawn time (a Studio preset, `claude`, …). */
	title?: string | null;
	/** Foreground process name from the Rust core — the live "what". */
	foreground?: string | null;
	/** Agent-assigned label (`POST /iyke/terminal/label`). */
	agentLabel?: string | null;
	/** True once the shell has exited; the label picks up a marker so a dead
	 *  tab doesn't keep claiming it's running something. */
	exited?: boolean;
	/** Absolute home dir, for `~` shortening. Pass `getHomeSync()`; an empty
	 *  string just means paths render in full. */
	home?: string;
}

export interface TerminalTitle {
	/** Short label for a tab — `claude · shell`. */
	label: string;
	/** Multi-line tooltip: label, full path, argv, agent lines. */
	tooltip: string;
	/** The "what" half on its own. */
	context: string;
	/** The "where" half on its own — a basename, `~`, or `''` if unknown. */
	dir: string;
}

/** Last path segment. Tolerates trailing slashes and Windows separators. */
function basename(p: string): string {
	const segs = p.split(/[/\\]+/).filter(Boolean);
	return segs[segs.length - 1] ?? '';
}

/** `/home/me/x` → `~/x` when `home` is known and prefixes it. */
function shorten(p: string, home: string): string {
	if (!home) return p;
	const h = home.replace(/\/+$/, '');
	if (p === h) return '~';
	return p.startsWith(`${h}/`) ? `~${p.slice(h.length)}` : p;
}

/** A login shell arrives from /proc as `-bash`; argv[0] may be an absolute
 *  path. Reduce both to the bare command name. */
function commandName(raw: string): string {
	return basename(raw.replace(/^-/, ''));
}

/**
 * Build the display title for one terminal.
 *
 * Precedence for the "what" half, most to least authoritative:
 *   1. the live foreground process   — what the terminal is running NOW
 *   2. the spawn-time title          — what it was opened as
 *   3. argv[0]                       — what it was told to run
 *   4. `shell`                       — nothing else to say
 *
 * The agent label is additive, never a replacement: an agent naming a terminal
 * `scout` shouldn't hide that `scout` is sitting in vim.
 */
export function formatTerminalTitle(input: TerminalTitleInput): TerminalTitle {
	const home = input.home ?? '';
	const cwd = (input.cwd ?? '').trim();
	const argv = input.argv ?? [];
	const spawnTitle = (input.title ?? '').trim();

	// The Rust core defaults a terminal's title to its joined argv (`"bash -l"`),
	// so an auto-generated title has to be recognised and dropped — otherwise a
	// popped-out terminal reads `bash -l · shell` where its origin tab reads
	// `bash · shell`. A title that differs from the argv was chosen by someone
	// (a Studio preset, a `claude` spawn) and is kept verbatim.
	const chosenTitle = spawnTitle && spawnTitle !== argv.join(' ') ? spawnTitle : '';

	const foreground = (input.foreground ?? '').trim();
	const context =
		(foreground && commandName(foreground)) ||
		chosenTitle ||
		(argv[0] ? commandName(argv[0]) : '') ||
		'shell';

	// `~` when the terminal sits exactly at home, else the last segment — a
	// basename is what actually distinguishes tabs, and it fits the ~180px a
	// tab gets. The full path is one hover away.
	const short = cwd ? shorten(cwd, home) : '';
	const dir = short === '~' ? '~' : cwd ? basename(cwd) || '/' : '';

	// A plain shell is the boring default — every tab leading with `bash ·`
	// is noise that crowds out the part that actually distinguishes them.
	// Drop it and show the directory alone; the shell is still on the tooltip's
	// argv line (and the restart button) when it matters. A real program keeps
	// its slot, because `claude · shell` and `vim · ikenga` are the whole point.
	const contextIsPlainShell = SHELL_NAMES.has(commandName(context));

	const agentLabel = (input.agentLabel ?? '').trim();
	// `dir` can be absent (unknown cwd), in which case even a shell name beats
	// rendering nothing at all.
	let label = dir ? (contextIsPlainShell ? dir : `${context} · ${dir}`) : context;
	if (agentLabel) label += ` (${agentLabel})`;
	if (input.exited) label += ' · exited';

	const lines = [label];
	if (short) lines.push(short);
	if (argv.length > 0) lines.push(argv.join(' '));
	// The context always comes from the foreground when one is observable, so
	// there's nothing to add except the one thing the label can't express: a
	// shell name means the terminal is idle at a prompt, not busy running a
	// program that happens to be called `bash`.
	if (foreground && SHELL_NAMES.has(commandName(foreground))) lines.push('at a prompt');
	if (agentLabel) lines.push(`agent label: ${agentLabel}`);

	return { label, tooltip: lines.join('\n'), context, dir };
}
