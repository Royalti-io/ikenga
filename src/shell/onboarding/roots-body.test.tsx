// roots-body — verifies the shell-store interactions the wizard relies on.

import { beforeEach, describe, expect, it } from 'vitest';

import {
	DEFAULT_CLAUDE_PROJECT_ROOTS,
	DEFAULT_FILE_ROOTS,
	useShellStore,
} from '@/lib/shell/shell-store';

import { mirrorProjectsToFileRoots } from './roots-body';

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

describe('roots step — Continue mirrors projects into file roots', () => {
	it('copies project paths into fileRoots, skipping ones already present', () => {
		// Start with a known file-root that overlaps one of the projects;
		// the mirror should leave it untouched (no duplicate) and add the
		// new path alongside.
		useShellStore.setState({
			fileRoots: ['~/Code/existing'],
			claudeProjectRoots: ['~/Code/existing', '~/Code/brand-new'],
		});

		mirrorProjectsToFileRoots(useShellStore.getState().claudeProjectRoots);

		const after = useShellStore.getState().fileRoots;
		expect(after).toContain('~/Code/existing');
		expect(after).toContain('~/Code/brand-new');
		// No duplicate of the overlapping entry.
		expect(after.filter((p) => p === '~/Code/existing')).toHaveLength(1);
	});

	it('is a no-op when projects list is empty', () => {
		useShellStore.setState({
			fileRoots: ['~/keep/this'],
			claudeProjectRoots: [],
		});
		mirrorProjectsToFileRoots([]);
		expect(useShellStore.getState().fileRoots).toEqual(['~/keep/this']);
	});
});
