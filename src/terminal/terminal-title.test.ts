/**
 * Pins the terminal naming contract: `<what's running> · <where>`, live-tracked
 * off the foreground process, with a graceful fallback chain so a terminal is
 * never anonymous.
 */

import { describe, expect, it } from 'vitest';

import { formatTerminalTitle } from './terminal-title';

const HOME = '/home/nedjamez';

describe('formatTerminalTitle — label', () => {
	it('is "<context> · <dir>" from the live foreground command', () => {
		const t = formatTerminalTitle({
			cwd: '/home/nedjamez/royalti-co/ikenga/shell',
			argv: ['bash', '-l'],
			title: 'bash',
			foreground: 'claude',
			home: HOME,
		});
		expect(t.label).toBe('claude · shell');
		expect(t.context).toBe('claude');
		expect(t.dir).toBe('shell');
	});

	it('tracks the foreground over the spawn title — a bash tab running vim reads vim', () => {
		const t = formatTerminalTitle({
			cwd: '/home/nedjamez/royalti-co/ikenga',
			argv: ['bash'],
			title: 'bash',
			foreground: 'vim',
			home: HOME,
		});
		expect(t.label).toBe('vim · ikenga');
	});

	it('omits a plain shell — an idle terminal is just its directory', () => {
		const t = formatTerminalTitle({
			cwd: '/home/nedjamez/royalti-co',
			argv: ['bash', '-l'],
			title: 'bash',
			foreground: 'bash',
			home: HOME,
		});
		expect(t.label).toBe('royalti-co');
		// Still recoverable on hover — that's why dropping it is safe.
		expect(t.tooltip).toContain('bash -l');
	});

	it('keeps the shell name when there is no directory to fall back on', () => {
		expect(formatTerminalTitle({ argv: ['bash'], foreground: 'bash' }).label).toBe('bash');
	});

	it('falls back to the spawn title when no foreground is observable', () => {
		const t = formatTerminalTitle({
			cwd: '/home/nedjamez/royalti-co/ikenga/shell',
			argv: ['claude'],
			title: 'claude',
			foreground: null,
			home: HOME,
		});
		expect(t.label).toBe('claude · shell');
	});

	it('falls back to argv[0] when there is no title either', () => {
		const t = formatTerminalTitle({ cwd: '/tmp/work', argv: ['/usr/bin/htop'], home: HOME });
		expect(t.label).toBe('htop · work');
	});

	it("ignores the Rust core's auto-title (the joined argv) so pop-outs match their origin tab", () => {
		const t = formatTerminalTitle({
			cwd: '/home/nedjamez/royalti-co/ikenga/shell',
			argv: ['bash', '-l'],
			title: 'bash -l', // what `TerminalDescriptor.title` defaults to
			home: HOME,
		});
		expect(t.label).toBe('shell');
	});

	it('keeps a deliberately chosen title that differs from the argv', () => {
		const t = formatTerminalTitle({
			cwd: '/home/nedjamez/royalti-co/ikenga/shell',
			argv: ['bun', 'run', 'render'],
			title: 'Render preview',
			home: HOME,
		});
		expect(t.label).toBe('Render preview · shell');
	});

	it('never renders empty — bare input still names itself', () => {
		expect(formatTerminalTitle({}).label).toBe('shell');
	});

	it('renders home as ~ rather than the username', () => {
		const t = formatTerminalTitle({ cwd: HOME, argv: ['bash'], foreground: 'bash', home: HOME });
		expect(t.label).toBe('~');
	});

	it('renders the filesystem root as /', () => {
		const t = formatTerminalTitle({ cwd: '/', argv: ['bash'], home: HOME });
		expect(t.label).toBe('/');
	});

	it('recognises a login shell despite the leading dash, so `-zsh` is omitted too', () => {
		// If the dash weren't stripped, `-zsh` wouldn't match the shell set and
		// would wrongly occupy the context slot.
		expect(formatTerminalTitle({ cwd: '/tmp', foreground: '-zsh', home: HOME }).label).toBe('tmp');
		expect(formatTerminalTitle({ cwd: '/tmp', argv: ['/bin/bash', '-l'], home: HOME }).label).toBe(
			'tmp'
		);
	});

	it('strips a directory prefix off a non-shell argv[0]', () => {
		const t = formatTerminalTitle({ cwd: '/tmp', argv: ['/usr/local/bin/claude'], home: HOME });
		expect(t.label).toBe('claude · tmp');
	});

	it('appends an agent label without hiding what is running', () => {
		const t = formatTerminalTitle({
			cwd: '/home/nedjamez/royalti-co',
			argv: ['bash'],
			foreground: 'vim',
			agentLabel: 'scout',
			home: HOME,
		});
		expect(t.label).toBe('vim · royalti-co (scout)');
	});

	it('marks an exited terminal so a dead tab stops claiming it is running', () => {
		const t = formatTerminalTitle({
			cwd: '/home/nedjamez/royalti-co/ikenga/shell',
			argv: ['claude'],
			title: 'claude',
			exited: true,
			home: HOME,
		});
		expect(t.label).toBe('claude · shell · exited');
	});

	it('drops the dir half entirely when cwd is unknown', () => {
		expect(formatTerminalTitle({ argv: ['claude'] }).label).toBe('claude');
	});

	it('leaves paths outside home unshortened', () => {
		const t = formatTerminalTitle({ cwd: '/opt/tools/bin', argv: ['bash'], home: HOME });
		expect(t.label).toBe('bin');
		expect(t.tooltip).toContain('/opt/tools/bin');
	});
});

describe('formatTerminalTitle — tooltip', () => {
	it('carries the full path and argv the label had to drop', () => {
		const t = formatTerminalTitle({
			cwd: '/home/nedjamez/royalti-co/ikenga/shell',
			argv: ['claude', '--resume', '8f2a'],
			title: 'claude',
			foreground: 'claude',
			home: HOME,
		});
		expect(t.tooltip.split('\n')).toEqual([
			'claude · shell',
			'~/royalti-co/ikenga/shell',
			'claude --resume 8f2a',
		]);
	});

	it('says "at a prompt" when the foreground is just a shell', () => {
		const t = formatTerminalTitle({
			cwd: '/home/nedjamez/royalti-co/ikenga/shell',
			argv: ['bash', '-l'],
			foreground: 'bash',
			home: HOME,
		});
		expect(t.label).toBe('shell');
		expect(t.tooltip).toContain('at a prompt');
	});

	it('names the agent label on its own line', () => {
		const t = formatTerminalTitle({
			cwd: '/tmp',
			argv: ['bash'],
			foreground: 'vim',
			agentLabel: 'scout',
			home: HOME,
		});
		expect(t.tooltip).toContain('agent label: scout');
	});
});
