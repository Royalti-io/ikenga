/**
 * Build the argv vector that `Pty.spawn` / `createTerminalSession` expects for
 * "open Claude in a terminal" affordances. Wraps `claude <flags>` in a bash
 * script that runs it once, prints the exit code on non-zero, then `exec`s
 * back into an interactive shell so the PTY survives any failure mode (stale
 * --resume id, killed-mid-tool JSONL, success). The user sees claude's real
 * stderr and can edit/retry the command in a live shell.
 *
 * Used by: session-detail "Open in terminal", new-session dialog Terminal
 * mode, and the /claude route's "Run command" buttons.
 */

export interface ClaudeWrapOpts {
	/** Claude session id to resume. Omit to start a fresh session. */
	resumeSessionId?: string | null;
	/** One-shot prompt — becomes `-p <prompt>`. */
	prompt?: string | null;
	/** `default` | `acceptEdits` | `plan` | etc. — becomes `--permission-mode`. */
	permissionMode?: string | null;
	model?: string | null;
}

/** POSIX single-quote escape: wrap in `'…'`, replace each `'` with `'\''`. */
function shQuote(arg: string): string {
	return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function buildClaudeWrappedCmd(opts: ClaudeWrapOpts = {}): string[] {
	const args = ['claude', '--dangerously-skip-permissions'];
	if (opts.resumeSessionId) args.push('--resume', opts.resumeSessionId);
	if (opts.permissionMode) args.push('--permission-mode', opts.permissionMode);
	if (opts.model) args.push('--model', opts.model);
	if (opts.prompt) args.push('-p', opts.prompt);

	const quoted = args.map(shQuote).join(' ');
	const script =
		`printf '\\033[2m$ %s\\033[0m\\n' ${shQuote(quoted)}; ` +
		`${quoted}; ` +
		`__status=$?; ` +
		`if [ $__status -ne 0 ]; then printf '\\n\\033[31m[claude exited %d]\\033[0m\\n' $__status; fi; ` +
		`exec "$SHELL" -i`;
	return ['/bin/bash', '-i', '-c', script];
}
