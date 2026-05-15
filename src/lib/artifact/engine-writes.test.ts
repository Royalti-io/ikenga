import { describe, expect, it } from 'vitest';
import { isArtifactWriteToolUse, type ToolUseLike } from './engine-writes';

const PATH = '/home/x/hello-world.html';

function use(name: string, input: unknown): ToolUseLike {
	return { kind: 'tool_use', id: 'u1', name, input };
}

describe('isArtifactWriteToolUse', () => {
	it('matches Write tool with file_path equal to artifact path', () => {
		expect(isArtifactWriteToolUse(use('Write', { file_path: PATH, content: 'x' }), PATH)).toBe(
			true,
		);
	});

	it('matches Edit tool', () => {
		expect(
			isArtifactWriteToolUse(use('Edit', { file_path: PATH, old_string: 'a', new_string: 'b' }), PATH),
		).toBe(true);
	});

	it('matches MultiEdit tool', () => {
		expect(isArtifactWriteToolUse(use('MultiEdit', { file_path: PATH, edits: [] }), PATH)).toBe(true);
	});

	it('matches lower-snake-case aliases (write_file, edit_file)', () => {
		expect(isArtifactWriteToolUse(use('write_file', { file_path: PATH }), PATH)).toBe(true);
		expect(isArtifactWriteToolUse(use('edit_file', { file_path: PATH }), PATH)).toBe(true);
	});

	it('accepts `path` as an alias for `file_path`', () => {
		expect(isArtifactWriteToolUse(use('Write', { path: PATH }), PATH)).toBe(true);
	});

	it('rejects tools we do not consider writes', () => {
		expect(isArtifactWriteToolUse(use('Read', { file_path: PATH }), PATH)).toBe(false);
		expect(isArtifactWriteToolUse(use('Bash', { command: 'ls' }), PATH)).toBe(false);
	});

	it('rejects writes to a different path', () => {
		expect(isArtifactWriteToolUse(use('Write', { file_path: '/other.html' }), PATH)).toBe(false);
	});

	it('rejects malformed input', () => {
		expect(isArtifactWriteToolUse(use('Write', null), PATH)).toBe(false);
		expect(isArtifactWriteToolUse(use('Write', { file_path: 42 }), PATH)).toBe(false);
		expect(isArtifactWriteToolUse(use('Write', {}), PATH)).toBe(false);
	});
});
