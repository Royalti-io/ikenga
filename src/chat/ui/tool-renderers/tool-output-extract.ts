/**
 * Pure extraction of a tool result's `output` into displayable text + images.
 *
 * Kept separate from `tool-output.tsx` so that file exports only a React
 * component — mixing a component and a plain function in one module breaks
 * react-refresh's Fast Refresh ("incompatible export") and forces a full reload
 * on every edit.
 *
 * A tool result's `output` (the FE `ChatEvent.tool_result.output`, which is the
 * engine's `raw_output`) can be a plain string or an array of content blocks.
 * Image-returning tools (e.g. `Read` of a PNG, or MCP tools) put image blocks
 * in that array. We pull them out so images render as images and only the text
 * remains as text.
 *
 * Tolerates both wire shapes for an image block:
 *   - Anthropic (what `raw_output` carries today):
 *       { type: 'image', source: { type: 'base64', media_type, data } }
 *   - ACP `ImageContent` (the spec channel, in case a caller reads `content`):
 *       { type: 'image', data, mimeType }
 */

export interface OutputImage {
	/** Ready-to-use `<img src>` — a `data:` URL for base64 blocks, or a direct
	 *  URL for url-sourced blocks. */
	src: string;
}

export interface ExtractedOutput {
	text: string;
	images: OutputImage[];
}

function imageFromBlock(block: unknown): OutputImage | null {
	if (!block || typeof block !== 'object') return null;
	const o = block as Record<string, unknown>;
	if (o.type !== 'image') return null;

	// ACP `ImageContent`: { data, mimeType }
	if (typeof o.data === 'string') {
		const mime = typeof o.mimeType === 'string' ? o.mimeType : 'image/png';
		return { src: `data:${mime};base64,${o.data}` };
	}
	// Anthropic: { source: { type, media_type, data } | { type:'url', url } }
	const source = o.source as Record<string, unknown> | undefined;
	if (source && typeof source.data === 'string') {
		const mime = typeof source.media_type === 'string' ? source.media_type : 'image/png';
		return { src: `data:${mime};base64,${source.data}` };
	}
	if (source && typeof source.url === 'string') {
		return { src: source.url };
	}
	return null;
}

/** Split a tool `output` value into joined text + extracted images. */
export function extractOutput(output: unknown): ExtractedOutput {
	const images: OutputImage[] = [];
	if (output == null) return { text: '', images };
	if (typeof output === 'string') return { text: output, images };

	if (Array.isArray(output)) {
		const textParts: string[] = [];
		for (const block of output) {
			const img = imageFromBlock(block);
			if (img) {
				images.push(img);
				continue;
			}
			if (block && typeof block === 'object' && 'text' in block) {
				textParts.push(String((block as { text: unknown }).text ?? ''));
				continue;
			}
			if (typeof block === 'string') {
				textParts.push(block);
				continue;
			}
			try {
				textParts.push(JSON.stringify(block));
			} catch {
				textParts.push(String(block));
			}
		}
		return { text: textParts.join('\n'), images };
	}

	// A single object: maybe a lone image block, otherwise pretty JSON.
	const img = imageFromBlock(output);
	if (img) return { text: '', images: [img] };
	try {
		return { text: JSON.stringify(output, null, 2), images };
	} catch {
		return { text: String(output), images };
	}
}
