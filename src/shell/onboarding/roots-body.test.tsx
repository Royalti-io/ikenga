// roots-body — verifies the shell-store interactions the wizard relies on.

import { beforeEach, describe, expect, it } from 'vitest';

import {
	DEFAULT_CLAUDE_PROJECT_ROOTS,
	DEFAULT_FILE_ROOTS,
	useShellStore,
} from '@/lib/shell/shell-store';

beforeEach(() => {
	// Reset just the roots slices to defaults; the wizard's persisted state
	// is irrelevant to these assertions.
	useShellStore.setState({
		fileRoots: [...DEFAULT_FILE_ROOTS],
		claudeProjectRoots: [...DEFAULT_CLAUDE_PROJECT_ROOTS],
	});
});

describe('roots step — store interactions', () => {
	it('pre-fills file roots from the default list', () => {
		const s = useShellStore.getState();
		expect(s.fileRoots).toEqual([...DEFAULT_FILE_ROOTS]);
	});

	it('appends a custom file root', () => {
		const s = useShellStore.getState();
		const before = s.fileRoots.length;
		s.addFileRoot('~/custom/path');
		expect(useShellStore.getState().fileRoots).toHaveLength(before + 1);
		expect(useShellStore.getState().fileRoots).toContain('~/custom/path');
	});

	it('ignores duplicates when adding the same path twice', () => {
		const s = useShellStore.getState();
		s.addFileRoot('~/dup');
		s.addFileRoot('~/dup');
		const count = useShellStore.getState().fileRoots.filter((p) => p === '~/dup').length;
		expect(count).toBe(1);
	});

	it('allows removing a default file root (no minimum enforced)', () => {
		const s = useShellStore.getState();
		const removed = DEFAULT_FILE_ROOTS[0]!;
		s.removeFileRoot(removed);
		expect(useShellStore.getState().fileRoots).not.toContain(removed);
	});

	it('pre-fills project roots from the default list', () => {
		const s = useShellStore.getState();
		expect(s.claudeProjectRoots).toEqual([...DEFAULT_CLAUDE_PROJECT_ROOTS]);
	});

	it('appends a custom project root', () => {
		const s = useShellStore.getState();
		s.addClaudeProjectRoot('~/projects/new');
		expect(useShellStore.getState().claudeProjectRoots).toContain('~/projects/new');
	});

	it('emptying both lists is allowed (continue still possible)', () => {
		const s = useShellStore.getState();
		for (const r of [...useShellStore.getState().fileRoots]) s.removeFileRoot(r);
		for (const r of [...useShellStore.getState().claudeProjectRoots]) s.removeClaudeProjectRoot(r);
		expect(useShellStore.getState().fileRoots).toEqual([]);
		expect(useShellStore.getState().claudeProjectRoots).toEqual([]);
	});
});
