// Artifact Studio — built-in shell mini-app (NOT a pkgs/* package).
//
// Top-level layout for the artifact authoring surface. The pane registry
// resolves `{ kind: 'artifact-studio', path }` here. Composed of four
// resizable panels (render | source | chat | manifest) plus chrome.
//
// User-facing copy always says "Artifact Studio"; internally we use
// `artifact-studio` (kebab) / `ArtifactStudio` (component) — never the
// bare word "Studio" since that collides with pkgs/studio/.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { FolderTree, Pin as PinGlyph, Save, SquareDashedMousePointer, X } from 'lucide-react';
import { cn } from '@/components/ui/utils';
import { fsRead, fsWrite } from '@/lib/tauri-cmd';
import { usePaneStore } from '@/lib/panes/pane-store';
import { StudioSourceEditor } from '@/shell/artifact-studio/studio-source-editor';
import { StudioManifestEditor } from '@/shell/artifact-studio/studio-manifest-editor';
import { StudioEngineChat } from '@/shell/artifact-studio/studio-engine-chat';
import { StudioCommentMode } from '@/shell/artifact-studio/studio-comment-mode';
import { StudioPromoteDialog } from '@/shell/artifact-studio/studio-promote-dialog';
import { ViewerRouter } from '@/viewer/auto-router';
import { extractManifestJson } from '@/lib/artifact/manifest-from-file';
import { writeManifestIntoHtml } from '@/lib/artifact/manifest-write';
import { getOrMintStudioThreadId } from '@/lib/artifact/studio-thread';
import { useChatStore } from '@/chat';
import { isArtifactWriteToolUse } from '@/lib/artifact/engine-writes';
import {
	ArtifactManifestSchema,
	type ArtifactManifest,
} from '@ikenga/contract/artifact';

interface ArtifactStudioProps {
	path: string;
	paneId: string;
}

export function ArtifactStudio({ path, paneId }: ArtifactStudioProps) {
	const [source, setSource] = useState<string | null>(null);
	const [savedSource, setSavedSource] = useState<string | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [commentMode, setCommentMode] = useState(false);
	const [promoteOpen, setPromoteOpen] = useState(false);
	const [pendingCommentChip, setPendingCommentChip] = useState<{ selector: string } | null>(null);

	// Initial load from disk. The viewer-server hot-reloads the iframe on
	// fsWrite, so we don't need to re-read after saves — but we do need the
	// initial source for the source editor + manifest extraction.
	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const result = await fsRead(path);
				const html = new TextDecoder('utf-8', { fatal: false }).decode(
					new Uint8Array(result.bytes),
				);
				if (!cancelled) {
					setSource(html);
					setSavedSource(html);
				}
			} catch (e) {
				if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [path]);

	const dirty = source !== null && savedSource !== null && source !== savedSource;

	// Parsed manifest preview. Pure derivation from source — re-runs on every
	// edit but is cheap (regex + JSON.parse on a kilobyte of text).
	const manifest = useMemo<ArtifactManifest | null>(() => {
		if (source === null) return null;
		const json = extractManifestJson(source);
		if (!json) return null;
		try {
			const parsed = JSON.parse(json);
			const validated = ArtifactManifestSchema.safeParse(parsed);
			return validated.success ? validated.data : (parsed as ArtifactManifest);
		} catch {
			return null;
		}
	}, [source]);

	const save = useCallback(async () => {
		if (source === null || !dirty) return;
		try {
			await fsWrite(path, new TextEncoder().encode(source));
			setSavedSource(source);
		} catch (e) {
			setLoadError(e instanceof Error ? e.message : String(e));
		}
	}, [path, source, dirty]);

	// Engine-driven edits auto-save (per the Phase 4 decision: ⌘S + auto-save
	// for engine-generated edits). User-driven edits in the source pane are
	// gated on ⌘S via `dirty`.
	const applyEngineEdit = useCallback(
		async (next: string) => {
			setSource(next);
			try {
				await fsWrite(path, new TextEncoder().encode(next));
				setSavedSource(next);
			} catch (e) {
				setLoadError(e instanceof Error ? e.message : String(e));
			}
		},
		[path],
	);

	useEngineWriteSync(path, (nextSource) => {
		setSource(nextSource);
		// The engine wrote directly to disk — what's now on disk is the canonical
		// state. Mark savedSource so the dirty indicator stays off and ⌘S won't
		// reapply a no-op.
		setSavedSource(nextSource);
	});

	// ⌘S / Ctrl+S inside the Studio pane. Scoped to keyboard events that
	// originate inside the pane root — we don't want Studio to swallow ⌘S
	// when the user is focused in a different pane.
	const onKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLDivElement>) => {
			const isSave = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's';
			if (isSave) {
				e.preventDefault();
				void save();
			}
		},
		[save],
	);

	// Engine-driven manifest edits write through immediately so the iframe
	// hot-reloads to show the change. User-driven manifest edits go through
	// the same writer but are gated on ⌘S via `dirty`.
	const updateManifest = useCallback(
		(next: ArtifactManifest, opts: { save?: boolean } = {}) => {
			if (source === null) return;
			const nextSource = writeManifestIntoHtml(source, next);
			setSource(nextSource);
			if (opts.save) {
				void fsWrite(path, new TextEncoder().encode(nextSource)).then(() =>
					setSavedSource(nextSource),
				);
			}
		},
		[path, source],
	);

	if (loadError) {
		return (
			<div className="flex h-full w-full items-center justify-center p-6 text-sm text-destructive">
				Failed to open artifact: {loadError}
			</div>
		);
	}
	if (source === null) {
		return (
			<div className="flex h-full w-full items-center justify-center p-6 text-sm text-muted-foreground">
				Loading…
			</div>
		);
	}

	return (
		<div
			className="flex h-full w-full flex-col bg-background"
			onKeyDown={onKeyDown}
			data-pane-id={paneId}
			role="application"
			aria-label="Artifact Studio"
		>
			<StudioChrome
				path={path}
				dirty={dirty}
				manifest={manifest}
				commentMode={commentMode}
				onCommentModeToggle={() => setCommentMode((v) => !v)}
				onSave={save}
				onPromote={() => setPromoteOpen(true)}
				onClose={() =>
					usePaneStore.getState().replaceActiveViewAndPushHistory(paneId, {
						kind: 'artifact',
						path,
					})
				}
				onPinToggle={() => {
					if (!manifest) return;
					updateManifest(
						{
							...manifest,
							pin: { ...(manifest.pin ?? { suggested: false }), suggested: !manifest.pin?.suggested },
						},
						{ save: true },
					);
				}}
			/>
			<div className="flex-1 overflow-hidden">
				<PanelGroup direction="horizontal" autoSaveId={`studio:${path}`}>
					<Panel defaultSize={40} minSize={20}>
						<div className="relative h-full w-full">
							<ViewerRouter path={path} source="pane" paneId={paneId} />
							{commentMode && (
								<StudioCommentMode
									paneId={paneId}
									onSelect={(selector) => setPendingCommentChip({ selector })}
								/>
							)}
						</div>
					</Panel>
					<PanelResizeHandle className="w-px bg-border hover:bg-accent" />
					<Panel defaultSize={30} minSize={15}>
						<StudioSourceEditor value={source} onChange={setSource} />
					</Panel>
					<PanelResizeHandle className="w-px bg-border hover:bg-accent" />
					<Panel defaultSize={30} minSize={15}>
						<PanelGroup direction="vertical" autoSaveId={`studio:right:${path}`}>
							<Panel defaultSize={60} minSize={20}>
								<StudioEngineChat
									path={path}
									pendingChip={pendingCommentChip}
									onConsumeChip={() => setPendingCommentChip(null)}
									onEngineEdit={applyEngineEdit}
								/>
							</Panel>
							<PanelResizeHandle className="h-px bg-border hover:bg-accent" />
							<Panel defaultSize={40} minSize={15}>
								<StudioManifestEditor
									manifest={manifest}
									onChange={(next) => updateManifest(next)}
								/>
							</Panel>
						</PanelGroup>
					</Panel>
				</PanelGroup>
			</div>
			<StudioPromoteDialog
				open={promoteOpen}
				onOpenChange={setPromoteOpen}
				path={path}
				source={source}
				manifest={manifest}
			/>
		</div>
	);
}

interface StudioChromeProps {
	path: string;
	dirty: boolean;
	manifest: ArtifactManifest | null;
	commentMode: boolean;
	onCommentModeToggle: () => void;
	onSave: () => void;
	onPromote: () => void;
	onPinToggle: () => void;
	onClose: () => void;
}

function StudioChrome({
	path,
	dirty,
	manifest,
	commentMode,
	onCommentModeToggle,
	onSave,
	onPromote,
	onPinToggle,
	onClose,
}: StudioChromeProps) {
	const name = manifest?.name ?? path.split('/').filter(Boolean).pop() ?? 'Artifact';
	const pinSuggested = manifest?.pin?.suggested === true;

	return (
		<div className="flex shrink-0 items-center gap-1.5 border-b border-border bg-muted/20 px-2 py-1 text-xs">
			<span className="font-medium text-foreground">{name}</span>
			{dirty && (
				<span
					className="h-1.5 w-1.5 rounded-full bg-amber-500"
					title="Unsaved changes — press ⌘S"
					role="status"
					aria-label="Unsaved changes"
				/>
			)}
			<span className="ml-auto flex items-center gap-0.5">
				<ChromeButton
					onClick={onCommentModeToggle}
					active={commentMode}
					title="Comment mode — click an element to annotate"
					aria-label="Toggle comment mode"
				>
					<SquareDashedMousePointer className="h-3.5 w-3.5" />
				</ChromeButton>
				<ChromeButton
					onClick={onPinToggle}
					active={pinSuggested}
					disabled={!manifest}
					title={pinSuggested ? 'Pin suggested (on)' : 'Pin suggested (off)'}
					aria-label="Toggle pin suggested"
				>
					<PinGlyph className={cn('h-3.5 w-3.5', pinSuggested && 'fill-current text-amber-500')} />
				</ChromeButton>
				<ChromeButton
					onClick={onPromote}
					title="Promote to folder…"
					aria-label="Promote to folder"
				>
					<FolderTree className="h-3.5 w-3.5" />
				</ChromeButton>
				<ChromeButton
					onClick={onSave}
					disabled={!dirty}
					title={dirty ? 'Save (⌘S)' : 'Saved'}
					aria-label="Save artifact"
				>
					<Save className="h-3.5 w-3.5" />
				</ChromeButton>
				<ChromeButton
					onClick={onClose}
					title="Close Studio (back to preview)"
					aria-label="Close Studio"
				>
					<X className="h-3.5 w-3.5" />
				</ChromeButton>
			</span>
		</div>
	);
}

interface ChromeButtonProps {
	onClick: () => void;
	active?: boolean;
	disabled?: boolean;
	title?: string;
	'aria-label': string;
	children: React.ReactNode;
}

function ChromeButton({ onClick, active, disabled, title, children, ...rest }: ChromeButtonProps) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			title={title}
			aria-label={rest['aria-label']}
			aria-pressed={active}
			className={cn(
				'flex h-6 w-6 items-center justify-center rounded transition-colors',
				active
					? 'bg-accent text-accent-foreground'
					: 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
				'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent',
			)}
		>
			{children}
		</button>
	);
}

// ─── Engine-write sync (ACP tool-result intercept) ───────────────────────
//
// Subscribes to the Studio's chat thread. When the engine calls one of its
// file-write tools (Write / Edit / MultiEdit / write_file / edit_file /
// multi_edit) against the artifact's path AND a non-error tool_result
// comes back, re-read the file from disk and feed it to `onWrite`. The
// caller updates `source` + `savedSource` so Monaco shows the new text and
// the dirty indicator stays off.
//
// Two correctness details:
//   1. `processedIds` tracks `tool_result.id`s we've already acted on, so a
//      re-render of the events list doesn't re-trigger writes.
//   2. `onWrite` is captured in a ref so updates to the closure (state
//      changes in the parent) don't restart the subscription — the
//      subscriber runs at most one effect for the artifact's lifetime.

function useEngineWriteSync(path: string, onWrite: (nextSource: string) => void) {
	const onWriteRef = useRef(onWrite);
	onWriteRef.current = onWrite;

	useEffect(() => {
		const threadId = getOrMintStudioThreadId(path);
		const processedIds = new Set<string>();

		const unsubscribe = useChatStore.subscribe((state) => {
			const events = state.threads[threadId]?.events;
			if (!events || events.length === 0) return;

			// Index tool_use events by id for O(1) lookup when matching results.
			const useById = new Map<string, ReturnType<typeof toToolUse>>();
			for (const e of events) {
				const u = toToolUse(e);
				if (u) useById.set(u.id, u);
			}

			for (const e of events) {
				if (e.kind !== 'tool_result') continue;
				if (processedIds.has(e.id)) continue;
				if (e.isError) {
					processedIds.add(e.id);
					continue;
				}
				const use = useById.get(e.id);
				if (!use || !isArtifactWriteToolUse(use, path)) {
					processedIds.add(e.id);
					continue;
				}
				processedIds.add(e.id);
				void fsRead(path)
					.then((res) => {
						const text = new TextDecoder('utf-8', { fatal: false }).decode(
							new Uint8Array(res.bytes),
						);
						onWriteRef.current(text);
					})
					.catch(() => {
						// Best-effort — if the re-read fails, the source editor stays
						// out of sync but the iframe (which uses its own fs_watch)
						// still reloads. The user can hit Refresh on the pane.
					});
			}
		});

		return () => {
			unsubscribe();
		};
	}, [path]);
}

/** Narrow a ChatEvent down to the tool_use shape `isArtifactWriteToolUse`
 *  expects. Returns null for any other kind. */
function toToolUse(
	e: unknown,
): { kind: 'tool_use'; id: string; name: string; input: unknown } | null {
	if (!e || typeof e !== 'object') return null;
	const ev = e as { kind?: unknown; id?: unknown; name?: unknown; input?: unknown };
	if (ev.kind !== 'tool_use' || typeof ev.id !== 'string' || typeof ev.name !== 'string') {
		return null;
	}
	return { kind: 'tool_use', id: ev.id, name: ev.name, input: ev.input };
}
