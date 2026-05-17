import { describe, expect, it } from 'vitest';
import {
	formatPaneAddressForDisplay,
	getPaneAddress,
	hasAddressBar,
	parsePaneAddress,
} from './pane-address';

describe('getPaneAddress', () => {
	it('returns the path for route views', () => {
		expect(getPaneAddress({ kind: 'route', path: '/inbox' })).toBe('/inbox');
	});

	it('coerces empty route paths to "/"', () => {
		expect(getPaneAddress({ kind: 'route', path: '' })).toBe('/');
	});

	it('returns the path for artifact views', () => {
		expect(getPaneAddress({ kind: 'artifact', path: '/tmp/x.html' })).toBe('/tmp/x.html');
	});

	it('returns null for chat views', () => {
		expect(getPaneAddress({ kind: 'chat', sessionId: 'abc' })).toBeNull();
	});

	it('returns null for terminal views', () => {
		expect(getPaneAddress({ kind: 'terminal', sessionId: 'tty1' })).toBeNull();
	});

	it('returns the bare path for a loupe with no attachment', () => {
		expect(getPaneAddress({ kind: 'artifact-studio', path: '/a.html', density: 'loupe' })).toBe(
			'/a.html'
		);
	});

	it('appends ?term=<id> when a terminal is attached to the loupe', () => {
		expect(
			getPaneAddress({
				kind: 'artifact-studio',
				path: '/a.html',
				density: 'loupe',
				attachedTerminalId: 'tab-abc',
			})
		).toBe('/a.html?term=tab-abc');
	});

	it('combines ?vs= and ?term= at compare density', () => {
		expect(
			getPaneAddress({
				kind: 'artifact-studio',
				path: '/a.html',
				density: 'compare',
				vs: '/b.html',
				attachedTerminalId: 'tab-abc',
			})
		).toBe('/a.html?vs=/b.html&term=tab-abc');
	});
});

describe('hasAddressBar', () => {
	it('is true for route + artifact', () => {
		expect(hasAddressBar({ kind: 'route', path: '/x' })).toBe(true);
		expect(hasAddressBar({ kind: 'artifact', path: '/y' })).toBe(true);
	});

	it('is false for chat + terminal', () => {
		expect(hasAddressBar({ kind: 'chat', sessionId: 's' })).toBe(false);
		expect(hasAddressBar({ kind: 'terminal', sessionId: 's' })).toBe(false);
	});
});

describe('parsePaneAddress', () => {
	it('returns null for empty input', () => {
		expect(parsePaneAddress('')).toBeNull();
		expect(parsePaneAddress('   ')).toBeNull();
	});

	it('parses https URLs as artifact (auto-router handles URLs)', () => {
		expect(parsePaneAddress('https://example.com/foo')).toEqual({
			kind: 'artifact',
			path: 'https://example.com/foo',
		});
	});

	it('parses http URLs as artifact', () => {
		expect(parsePaneAddress('http://localhost:3000')).toEqual({
			kind: 'artifact',
			path: 'http://localhost:3000',
		});
	});

	it('keeps the literal ikenga://artifact/<id> URI for the async resolver', () => {
		// The parser is sync; rewriting to a real on-disk path needs a Tauri
		// round-trip and lives in pane-address-resolver.ts. Keep the URI here
		// so the resolver can detect it downstream.
		expect(parsePaneAddress('ikenga://artifact/abc-123')).toEqual({
			kind: 'artifact',
			path: 'ikenga://artifact/abc-123',
		});
	});

	it('rejects ikenga://artifact/ with empty suffix', () => {
		expect(parsePaneAddress('ikenga://artifact/')).toBeNull();
	});

	it('rejects unknown URI schemes', () => {
		expect(parsePaneAddress('mailto:a@b.com')).toBeNull();
		expect(parsePaneAddress('foo://bar')).toBeNull();
	});

	it('parses a leading-slash route', () => {
		expect(parsePaneAddress('/inbox')).toEqual({
			kind: 'route',
			path: '/inbox',
		});
	});

	it('parses a leading-slash filesystem path with extension as artifact', () => {
		expect(parsePaneAddress('/home/me/x.html')).toEqual({
			kind: 'artifact',
			path: '/home/me/x.html',
		});
	});

	it('parses /Users/... as artifact (mac home)', () => {
		expect(parsePaneAddress('/Users/me/notes')).toEqual({
			kind: 'artifact',
			path: '/Users/me/notes',
		});
	});

	it('parses Windows drive paths as artifact', () => {
		expect(parsePaneAddress('C:\\Users\\me\\x.txt')).toEqual({
			kind: 'artifact',
			path: 'C:\\Users\\me\\x.txt',
		});
		expect(parsePaneAddress('D:/projects/foo')).toEqual({
			kind: 'artifact',
			path: 'D:/projects/foo',
		});
	});

	it('parses relative paths containing a dot as artifact', () => {
		expect(parsePaneAddress('docs/readme.md')).toEqual({
			kind: 'artifact',
			path: 'docs/readme.md',
		});
	});

	it('parses relative paths containing a slash as artifact', () => {
		expect(parsePaneAddress('a/b')).toEqual({ kind: 'artifact', path: 'a/b' });
	});

	it('rejects bare words with no slash, dot, or scheme', () => {
		expect(parsePaneAddress('inbox')).toBeNull();
		expect(parsePaneAddress('hello world')).toBeNull();
	});

	it('trims surrounding whitespace before parsing', () => {
		expect(parsePaneAddress('  /inbox  ')).toEqual({
			kind: 'route',
			path: '/inbox',
		});
	});
});

describe('formatPaneAddressForDisplay', () => {
	it('returns the canonical URI for an artifact whose path is pinned', () => {
		const map = new Map([['/home/me/cfo.html', 'cfo-daily']]);
		expect(formatPaneAddressForDisplay({ kind: 'artifact', path: '/home/me/cfo.html' }, map)).toBe(
			'ikenga://artifact/cfo-daily'
		);
	});

	it('returns the file path for an unpinned artifact', () => {
		const map = new Map([['/home/me/cfo.html', 'cfo-daily']]);
		expect(
			formatPaneAddressForDisplay({ kind: 'artifact', path: '/home/me/notes.html' }, map)
		).toBe('/home/me/notes.html');
	});

	it('returns the file path when no pins exist', () => {
		expect(formatPaneAddressForDisplay({ kind: 'artifact', path: '/x.html' }, new Map())).toBe(
			'/x.html'
		);
	});

	it('returns the URL for an external artifact (https) when not pinned', () => {
		expect(
			formatPaneAddressForDisplay({ kind: 'artifact', path: 'https://example.com/dash' }, new Map())
		).toBe('https://example.com/dash');
	});

	it('returns the URI when an external URL is itself the pinned target', () => {
		const map = new Map([['https://example.com/dash', 'example-dash']]);
		expect(
			formatPaneAddressForDisplay({ kind: 'artifact', path: 'https://example.com/dash' }, map)
		).toBe('ikenga://artifact/example-dash');
	});

	it('passes route views straight through to getPaneAddress', () => {
		const map = new Map([['/inbox', 'should-not-match']]);
		// Routes are matched by kind, not by path-membership in the pinned map.
		expect(formatPaneAddressForDisplay({ kind: 'route', path: '/inbox' }, map)).toBe('/inbox');
	});

	it('returns null for views without a natural address (chat / terminal)', () => {
		expect(formatPaneAddressForDisplay({ kind: 'chat', sessionId: 'abc' }, new Map())).toBeNull();
		expect(
			formatPaneAddressForDisplay({ kind: 'terminal', sessionId: 'tty1' }, new Map())
		).toBeNull();
	});
});
