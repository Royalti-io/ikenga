/**
 * Built-in Claude Code slash commands surfaced in the chat autocomplete.
 *
 * Background: the `claude` CLI's stream-json input mode (which our
 * Rust ACP server drives) does NOT execute slash commands the way the
 * interactive TUI does. A literal `/clear` typed into our chat would
 * be sent as a user message containing the text `/clear`, not invoke
 * the actual reset semantics.
 *
 * So instead of forwarding built-ins to the engine, we map each one
 * to an in-app action — either a UI affordance we already ship (model
 * picker, settings page, packages browser) or a terminal handoff into
 * a real interactive `claude` session for commands that require the
 * TUI (`/login`, `/compact`, `/memory`).
 *
 * Override semantics: if the user has a same-named `.md` file in
 * `~/.claude/commands/` or `<cwd>/.claude/commands/`, that wins (per
 * the existing `loadSlashCommands` shadowing rule). Built-ins are the
 * lowest tier — they only render when no user/project command shadows
 * them.
 */

/** Where the action takes effect. `action: null` is for commands like
 *  `/cost` that have no separate UI action (the info is already
 *  visible in the composer/header). */
export type BuiltinAction =
	| { type: 'navigate'; to: string }
	| { type: 'new-thread' }
	| { type: 'open-engine-picker' }
	| { type: 'open-effort-picker' }
	| { type: 'open-mode-picker' }
	| { type: 'open-attach-file' }
	| { type: 'terminal-handoff'; command: string }
	| { type: 'open-external'; url: string }
	| { type: 'noop'; hint: string };

export interface BuiltinSlashCommand {
	name: string;
	description: string;
	action: BuiltinAction;
}

export const BUILTIN_SLASH_COMMANDS: BuiltinSlashCommand[] = [
	{
		name: 'clear',
		description: 'Start a new thread (preserves prior thread in /sessions)',
		action: { type: 'new-thread' },
	},
	{
		name: 'compact',
		description: 'Compact the conversation — opens a terminal claude session',
		action: { type: 'terminal-handoff', command: '/compact' },
	},
	{
		name: 'memory',
		description: 'Edit CLAUDE.md memory — opens a terminal claude session',
		action: { type: 'terminal-handoff', command: '/memory' },
	},
	{
		name: 'cost',
		description: 'Cumulative cost — already shown in the chat header',
		action: {
			type: 'noop',
			hint: 'Cumulative cost is shown in the chat header (SPENT $…).',
		},
	},
	{
		name: 'model',
		description: 'Switch model — opens the composer Model popover',
		action: { type: 'open-engine-picker' },
	},
	{
		name: 'effort',
		description: 'Switch effort — opens the composer Effort popover',
		action: { type: 'open-effort-picker' },
	},
	{
		name: 'mode',
		description: 'Switch session mode (plan / auto / bypass)',
		action: { type: 'open-mode-picker' },
	},
	{
		name: 'login',
		description: 'Re-authenticate claude — opens a terminal session',
		action: { type: 'terminal-handoff', command: '/login' },
	},
	{
		name: 'logout',
		description: 'Sign out of claude — opens a terminal session',
		action: { type: 'terminal-handoff', command: '/logout' },
	},
	{
		name: 'agents',
		description: 'Manage engines — go to /settings/agent',
		action: { type: 'navigate', to: '/settings/agent' },
	},
	{
		name: 'mcp',
		description: 'Manage MCP servers — go to /packages',
		action: { type: 'navigate', to: '/packages' },
	},
	{
		name: 'config',
		description: 'Open Ikenga settings',
		action: { type: 'navigate', to: '/settings' },
	},
	{
		name: 'init',
		description: 'Initialize the workspace — go to onboarding',
		action: { type: 'navigate', to: '/onboarding' },
	},
	{
		name: 'resume',
		description: 'Resume a session — go to /sessions',
		action: { type: 'navigate', to: '/sessions' },
	},
	{
		name: 'attach',
		description: 'Attach a file or image to this turn',
		action: { type: 'open-attach-file' },
	},
	{
		name: 'help',
		description: 'Ikenga help',
		action: { type: 'open-external', url: 'https://ikenga.dev/docs' },
	},
	{
		name: 'bug',
		description: 'Report a bug — opens the GitHub issues page',
		action: { type: 'open-external', url: 'https://github.com/royalti-io/ikenga/issues' },
	},
	{
		name: 'exit',
		description: 'Close the current chat tab',
		action: { type: 'noop', hint: 'Close the tab via ⌘W or the tab × button.' },
	},
];
