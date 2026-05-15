// Promote-to-folder dialog.
//
// Per the Phase 4 decision: "ask each time" — show a dialog with checkboxes
// so the user picks how much to split. Default folder name = manifest.id;
// options: split CSS (extracts <style> blocks into assets/styles.css), split
// JSX (extracts <script type="text/babel"> into assets/app.jsx), extract
// mock data (pulls the <script id="ikenga-mock-data"> JSON into
// assets/mock.json), copy linked images (resolves relative `src=` paths
// next to the source and copies them to assets/).
//
// All splits round-trip back into the HTML as references (<link>, <script
// src=>, etc.) so the promoted folder is a working artifact under the
// folder-mode rules in the schema (entry: 'index.html').
//
// v0 scope: the dialog wires up CSS split, JSX split, mock-data split, and
// manifest extraction. Linked-image copying is deferred — manifest writers
// usually inline data-URIs for the icon and pull external images on demand
// via the bridge, so this is rarely needed in practice. We expose the
// checkbox but disable it with a "deferred" tooltip.

import { useCallback, useMemo, useState } from 'react';
import { FolderTree, Loader2 } from 'lucide-react';
import { ArtifactManifestSchema, type ArtifactManifest } from '@ikenga/contract/artifact';
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/components/ui/utils';
import { fsWrite } from '@/lib/tauri-cmd';

interface StudioPromoteDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	path: string;
	source: string;
	manifest: ArtifactManifest | null;
}

interface PromoteOptions {
	splitCss: boolean;
	splitJsx: boolean;
	extractMockData: boolean;
	copyLinkedImages: boolean;
}

const DEFAULT_OPTIONS: PromoteOptions = {
	splitCss: true,
	splitJsx: true,
	extractMockData: true,
	copyLinkedImages: false,
};

export function StudioPromoteDialog({
	open,
	onOpenChange,
	path,
	source,
	manifest,
}: StudioPromoteDialogProps) {
	const defaultFolderName = useMemo(() => manifest?.id ?? deriveFolderName(path), [manifest, path]);
	const [folderName, setFolderName] = useState(defaultFolderName);
	const [options, setOptions] = useState<PromoteOptions>(DEFAULT_OPTIONS);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const update = useCallback((patch: Partial<PromoteOptions>) => {
		setOptions((o) => ({ ...o, ...patch }));
	}, []);

	const handlePromote = useCallback(async () => {
		setBusy(true);
		setError(null);
		try {
			const result = promoteToFolder({ source, options, manifest });
			const parentDir = path.replace(/\/[^/]+$/, '');
			const targetDir = `${parentDir}/${folderName}`;

			// fsWrite auto-creates parent dirs, so a single round of writes
			// covers the folder structure.
			const encoder = new TextEncoder();
			await Promise.all([
				fsWrite(`${targetDir}/index.html`, encoder.encode(result.html)),
				fsWrite(`${targetDir}/manifest.json`, encoder.encode(result.manifestJson)),
				...(result.stylesCss
					? [fsWrite(`${targetDir}/assets/styles.css`, encoder.encode(result.stylesCss))]
					: []),
				...(result.appJsx
					? [fsWrite(`${targetDir}/assets/app.jsx`, encoder.encode(result.appJsx))]
					: []),
				...(result.mockJson
					? [fsWrite(`${targetDir}/assets/mock.json`, encoder.encode(result.mockJson))]
					: []),
			]);
			onOpenChange(false);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	}, [path, folderName, source, options, manifest, onOpenChange]);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<FolderTree className="h-4 w-4" />
						Promote to folder
					</DialogTitle>
					<DialogDescription>
						Split this single-file artifact into a folder with separate manifest, styles, and
						scripts. Pick what to extract.
					</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-3 text-xs">
					<div className="flex flex-col gap-1">
						<span className="font-mono text-[10px] text-muted-foreground">folder name</span>
						<Input
							value={folderName}
							onChange={(e) => setFolderName(e.target.value)}
							placeholder="my-artifact"
							className="h-7 text-xs"
						/>
					</div>
					<OptionRow
						label="Split CSS into assets/styles.css"
						checked={options.splitCss}
						onChange={(v) => update({ splitCss: v })}
					/>
					<OptionRow
						label="Split JSX into assets/app.jsx"
						checked={options.splitJsx}
						onChange={(v) => update({ splitJsx: v })}
					/>
					<OptionRow
						label="Extract mock data into assets/mock.json"
						checked={options.extractMockData}
						onChange={(v) => update({ extractMockData: v })}
					/>
					<OptionRow
						label="Copy linked images (deferred — does nothing yet)"
						checked={options.copyLinkedImages}
						onChange={(v) => update({ copyLinkedImages: v })}
						disabled
					/>
					{error && <span className="text-destructive">{error}</span>}
				</div>
				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
						Cancel
					</Button>
					<Button onClick={handlePromote} disabled={busy || !folderName.trim()}>
						{busy && <Loader2 className="mr-2 h-3 w-3 animate-spin" />}
						Promote
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

interface OptionRowProps {
	label: string;
	checked: boolean;
	onChange: (v: boolean) => void;
	disabled?: boolean;
}

function OptionRow({ label, checked, onChange, disabled }: OptionRowProps) {
	return (
		<div
			className={cn(
				'flex items-center justify-between gap-2',
				disabled && 'opacity-60',
			)}
		>
			<span>{label}</span>
			<Switch checked={checked} onCheckedChange={onChange} disabled={disabled} />
		</div>
	);
}

// ---------- Pure split logic ----------

interface PromoteResult {
	html: string;
	manifestJson: string;
	stylesCss: string | null;
	appJsx: string | null;
	mockJson: string | null;
}

interface PromoteInput {
	source: string;
	options: PromoteOptions;
	manifest: ArtifactManifest | null;
}

const STYLE_BLOCK_RE = /<style[^>]*>([\s\S]*?)<\/style>/gi;
const BABEL_BLOCK_RE = /<script\s+[^>]*?type\s*=\s*["']text\/babel["'][^>]*?>([\s\S]*?)<\/script>/gi;
const MOCK_BLOCK_RE =
	/<script\s+[^>]*?\bid\s*=\s*["']ikenga-mock-data["'][^>]*?>([\s\S]*?)<\/script>/i;
const MANIFEST_BLOCK_RE =
	/<script\s+[^>]*?\bid\s*=\s*["']ikenga-manifest["'][^>]*?>([\s\S]*?)<\/script>/i;

/** Pure transform. Exported for unit tests. */
export function promoteToFolder({ source, options, manifest }: PromoteInput): PromoteResult {
	let html = source;
	let stylesCss: string | null = null;
	let appJsx: string | null = null;
	let mockJson: string | null = null;

	if (options.splitCss) {
		const collected: string[] = [];
		html = html.replace(STYLE_BLOCK_RE, (_match, body) => {
			collected.push(String(body).trim());
			return '';
		});
		if (collected.length > 0) {
			stylesCss = collected.join('\n\n');
			html = injectIntoHead(html, '\n\t<link rel="stylesheet" href="assets/styles.css">');
		}
	}

	if (options.splitJsx) {
		const collected: string[] = [];
		html = html.replace(BABEL_BLOCK_RE, (_match, body) => {
			collected.push(String(body).trim());
			return '';
		});
		if (collected.length > 0) {
			appJsx = collected.join('\n\n');
			html = injectBeforeBodyClose(
				html,
				'\n\t<script type="text/babel" src="assets/app.jsx"></script>',
			);
		}
	}

	if (options.extractMockData) {
		const match = MOCK_BLOCK_RE.exec(html);
		if (match) {
			mockJson = match[1].trim();
			html = html.replace(
				MOCK_BLOCK_RE,
				'<script type="application/json" id="ikenga-mock-data" src="assets/mock.json"></script>',
			);
		}
	}

	// Strip the inline manifest tag — folder mode puts the manifest in
	// manifest.json next to index.html. The bridge prefers manifest.json
	// when it sees a folder structure.
	html = html.replace(MANIFEST_BLOCK_RE, '');
	const manifestForFolder = manifest ? folderModeManifest(manifest) : MIN_MANIFEST_TEMPLATE;
	const manifestJson = JSON.stringify(manifestForFolder, null, 2);

	return { html: html.trimStart(), manifestJson, stylesCss, appJsx, mockJson };
}

const MIN_MANIFEST_TEMPLATE = {
	format: 'ikenga-artifact' as const,
	formatVersion: '0.1',
	id: 'promoted-artifact',
	name: 'Promoted Artifact',
	version: '0.1.0',
	entry: 'index.html',
	dataSources: {},
	fallback: { mode: 'mock' as const, data: 'assets/mock.json' },
};

/** Folder-mode manifest is the same shape, but `entry` is set and (if mock
 *  data was extracted) `fallback.data` points to the JSON file rather than
 *  the inline script tag id. */
function folderModeManifest(manifest: ArtifactManifest): ArtifactManifest {
	const next: ArtifactManifest = { ...manifest, entry: 'index.html' };
	if (next.fallback?.mode === 'mock' && next.fallback.dataTag && !next.fallback.data) {
		next.fallback = { mode: 'mock', data: 'assets/mock.json' };
	}
	// Best-effort schema check — fall back to whatever the user had.
	const parsed = ArtifactManifestSchema.safeParse(next);
	return parsed.success ? parsed.data : next;
}

function injectIntoHead(html: string, frag: string): string {
	if (/<head[^>]*>/i.test(html)) {
		return html.replace(/(<head[^>]*>)/i, (m) => `${m}${frag}`);
	}
	return frag + html;
}

function injectBeforeBodyClose(html: string, frag: string): string {
	if (/<\/body\s*>/i.test(html)) {
		return html.replace(/<\/body\s*>/i, (m) => `${frag}\n${m}`);
	}
	return html + frag;
}

function deriveFolderName(path: string): string {
	const name = path.split('/').filter(Boolean).pop() ?? 'artifact';
	return name.replace(/\.[^.]+$/, '').toLowerCase();
}
