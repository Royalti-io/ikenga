// Hybrid MIME detection for the viewer auto-router. Cheap JS extension table
// first so the hot path stays synchronous; falls through to the Rust
// `fs_mime` command (mime_guess crate) for unknown extensions so we still get
// a useful answer for files like `Dockerfile`, `Makefile`, or unknown
// extensions where mime_guess has a richer table than ours.

import { fsMime } from '@/lib/tauri-cmd';

const EXT_MIME: Record<string, string> = {
	// text/markup
	html: 'text/html',
	htm: 'text/html',
	xml: 'application/xml',
	svg: 'image/svg+xml',
	md: 'text/markdown',
	mdx: 'text/markdown',
	txt: 'text/plain',
	log: 'text/plain',
	csv: 'text/csv',
	tsv: 'text/tab-separated-values',
	// structured
	json: 'application/json',
	jsonl: 'application/json',
	json5: 'application/json',
	yaml: 'application/yaml',
	yml: 'application/yaml',
	toml: 'application/toml',
	ini: 'text/plain',
	env: 'text/plain',
	// code
	ts: 'text/x-typescript',
	tsx: 'text/x-typescript',
	js: 'text/javascript',
	jsx: 'text/javascript',
	mjs: 'text/javascript',
	cjs: 'text/javascript',
	rs: 'text/x-rust',
	py: 'text/x-python',
	rb: 'text/x-ruby',
	go: 'text/x-go',
	java: 'text/x-java',
	kt: 'text/x-kotlin',
	swift: 'text/x-swift',
	sh: 'text/x-shellscript',
	bash: 'text/x-shellscript',
	zsh: 'text/x-shellscript',
	fish: 'text/x-shellscript',
	sql: 'text/x-sql',
	graphql: 'text/plain',
	gql: 'text/plain',
	css: 'text/css',
	scss: 'text/x-scss',
	sass: 'text/x-sass',
	// pdf
	pdf: 'application/pdf',
	// images
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	bmp: 'image/bmp',
	ico: 'image/x-icon',
	avif: 'image/avif',
	// video
	mp4: 'video/mp4',
	webm: 'video/webm',
	mov: 'video/quicktime',
	mkv: 'video/x-matroska',
	// audio
	mp3: 'audio/mpeg',
	wav: 'audio/wav',
	ogg: 'audio/ogg',
	flac: 'audio/flac',
	m4a: 'audio/mp4',
	aac: 'audio/aac',
	// spreadsheets / pencil
	xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	xls: 'application/vnd.ms-excel',
	pen: 'application/x-pencil',
};

export function extensionOf(path: string): string {
	const base = path.split('/').pop() ?? '';
	// Dotfiles: `.gitignore`, `.env` — strip the leading dot and treat the
	// rest as the extension.
	if (base.startsWith('.') && !base.slice(1).includes('.')) {
		return base.slice(1).toLowerCase();
	}
	const dot = base.lastIndexOf('.');
	return dot === -1 ? '' : base.slice(dot + 1).toLowerCase();
}

/** Hybrid lookup: extension table first, fs_mime fallback on miss. */
export async function resolveMime(path: string): Promise<string> {
	const ext = extensionOf(path);
	const fromExt = ext && EXT_MIME[ext];
	if (fromExt) return fromExt;
	try {
		return await fsMime(path);
	} catch {
		return 'application/octet-stream';
	}
}

/** Synchronous extension lookup for the auto-router's first paint. Returns
 * undefined for unknown extensions so the caller knows to await
 * `resolveMime`. */
export function mimeFromExt(path: string): string | undefined {
	const ext = extensionOf(path);
	return ext ? EXT_MIME[ext] : undefined;
}

export function isCodeMime(mime: string, path: string): boolean {
	if (mime.startsWith('text/')) return true;
	if (mime === 'application/json') return true;
	if (mime === 'application/yaml') return true;
	if (mime === 'application/toml') return true;
	if (mime === 'application/xml') return true;
	// mime_guess returns octet-stream for unknown — fall back to extension
	if (mime === 'application/octet-stream') {
		const ext = extensionOf(path);
		return ext in EXT_MIME && EXT_MIME[ext]!.startsWith('text/');
	}
	return false;
}
