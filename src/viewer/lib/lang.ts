// Map file extensions / mimes to shiki language identifiers. Kept narrow so
// we only pull grammars we actually use — shiki tree-shakes per-lang.

import { extname } from './path';

const EXT_LANG: Record<string, string> = {
	'.ts': 'ts',
	'.tsx': 'tsx',
	'.js': 'js',
	'.jsx': 'jsx',
	'.mjs': 'js',
	'.cjs': 'js',
	'.json': 'json',
	'.jsonl': 'json',
	'.json5': 'json5',
	'.yaml': 'yaml',
	'.yml': 'yaml',
	'.toml': 'toml',
	'.md': 'md',
	'.mdx': 'mdx',
	'.html': 'html',
	'.htm': 'html',
	'.xml': 'xml',
	'.svg': 'xml',
	'.css': 'css',
	'.scss': 'scss',
	'.sass': 'sass',
	'.rs': 'rust',
	'.py': 'python',
	'.rb': 'ruby',
	'.go': 'go',
	'.java': 'java',
	'.kt': 'kotlin',
	'.swift': 'swift',
	'.sh': 'shell',
	'.bash': 'shell',
	'.zsh': 'shell',
	'.fish': 'shell',
	'.sql': 'sql',
	'.graphql': 'graphql',
	'.gql': 'graphql',
	'.dockerfile': 'docker',
};

export function detectLang(path: string): string {
	const ext = extname(path);
	if (ext && ext in EXT_LANG) return EXT_LANG[ext]!;
	// dotfiles
	const lower = path.toLowerCase();
	if (lower.endsWith('/dockerfile') || lower.endsWith('dockerfile')) return 'docker';
	if (lower.endsWith('/makefile') || lower.endsWith('makefile')) return 'make';
	return 'text';
}
