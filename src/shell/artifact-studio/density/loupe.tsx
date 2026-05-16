// Loupe density — single-artifact view.
//
// Layout: chrome / [renderer | right-rail] / version-strip.
//
// Right rail is tabbed (Chat / Code / DOM / Manifest), default Chat.
// The Code, DOM, and Manifest tabs are only meaningful for a single
// focused artifact, so they live on this density only (grid and compare
// surface Chat-only rails per the unified plan).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { FolderTree, Pin as PinGlyph, Save, SquareDashedMousePointer, X } from 'lucide-react';
import { cn } from '@/components/ui/utils';
import { fsRead, fsWrite } from '@/lib/tauri-cmd';
import { usePaneStore } from '@/lib/panes/pane-store';
import { useChatStore } from '@/chat';
import { StudioSourceEditor } from '@/shell/artifact-studio/studio-source-editor';
import { StudioManifestEditor } from '@/shell/artifact-studio/studio-manifest-editor';
import { StudioEngineChat } from '@/shell/artifact-studio/studio-engine-chat';
import { StudioCommentMode } from '@/shell/artifact-studio/studio-comment-mode';
import { StudioPromoteDialog } from '@/shell/artifact-studio/studio-promote-dialog';
import { pickRenderer } from '@/shell/artifact-studio/renderers';
import { RightRail, useRightRailTab } from '@/shell/artifact-studio/right-rail';
import { VersionStrip } from '@/shell/artifact-studio/version-strip';
import { extractManifestJson } from '@/lib/artifact/manifest-from-file';
import { writeManifestIntoHtml } from '@/lib/artifact/manifest-write';
import { getOrMintStudioThreadId } from '@/lib/artifact/studio-thread';
import { isArtifactWriteToolUse } from '@/lib/artifact/engine-writes';
import { ArtifactManifestSchema, type ArtifactManifest } from '@ikenga/contract/artifact';

interface StudioLoupeProps {
	path: string;
	paneId: string;
}

export function StudioLoupe({ path, paneId }: StudioLoupeProps) {
	const [source, setSource] = useState<string | null>(null);
	const [savedSource, setSavedSource] = useState<string | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [commentMode, setCommentMode] = useState(false);
	const [promoteOpen, setPromoteOpen] = useState(false);
	const [pendingCommentChip, setPendingCommentChip] = useState<{ selector: string } | null>(null);
	const [rightTab, setRightTab] = useRightRailTab('chat');

	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const result = await fsRead(path);
				const html = new TextDecoder('utf-8', { fatal: false }).decode(
					new Uint8Array(result.bytes)
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
		[path]
	);

	useEngineWriteSync(path, (nextSource) => {
		setSource(nextSource);
		setSavedSource(nextSource);
	});

	const onKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLDivElement>) => {
			const isSave = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's';
			if (isSave) {
				e.preventDefault();
				void save();
			}
		},
		[save]
	);

	const updateManifest = useCallback(
		(next: ArtifactManifest, opts: { save?: boolean } = {}) => {
			if (source === null) return;
			const nextSource = writeManifestIntoHtml(source, next);
			setSource(nextSource);
			if (opts.save) {
				void fsWrite(path, new TextEncoder().encode(nextSource)).then(() =>
					setSavedSource(nextSource)
				);
			}
		},
		[path, source]
	);

	// Renderer kind hint deferred — today's ArtifactManifest schema is
	// HTML-flavoured (no `kind` field). When the schema grows a discriminator
	// (open question 1 in the unified plan), thread it in here.
	const Renderer = useMemo(() => pickRenderer(path).Component, [path]);

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
							pin: {
								...(manifest.pin ?? { suggested: false }),
								suggested: !manifest.pin?.suggested,
							},
						},
						{ save: true }
					);
				}}
			/>
			<div className="flex-1 min-h-0 overflow-hidden">
				<PanelGroup direction="horizontal" autoSaveId={`studio-loupe:${path}`}>
					<Panel defaultSize={70} minSize={30}>
						<div className="relative h-full w-full">
							<Renderer path={path} paneId={paneId} density="loupe" source="pane" />
							{commentMode && (
								<StudioCommentMode
									paneId={paneId}
									onSelect={(selector) => setPendingCommentChip({ selector })}
								/>
							)}
						</div>
					</Panel>
					<PanelResizeHandle className="w-px bg-border hover:bg-accent" />
					<Panel defaultSize={30} minSize={20}>
						<RightRail
							tab={rightTab}
							onChangeTab={setRightTab}
							slots={{
								chat: (
									<StudioEngineChat
										path={path}
										pendingChip={pendingCommentChip}
										onConsumeChip={() => setPendingCommentChip(null)}
										onEngineEdit={applyEngineEdit}
									/>
								),
								code: <StudioSourceEditor value={source} onChange={setSource} />,
								dom: <DomInspectorPlaceholder paneId={paneId} />,
								manifest: (
									<StudioManifestEditor
										manifest={manifest}
										onChange={(next) => updateManifest(next)}
									/>
								),
							}}
						/>
					</Panel>
				</PanelGroup>
			</div>
			<VersionStrip paneId={paneId} path={path} />
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

// ─── DOM inspector ────────────────────────────────────────────────────
//
// Locked in Phase 2 (Open Question 7): the iyke viewer-server already
// injects the iyke iframe bridge into every served artifact, and the
// bridge already responds to `iyke://dom-request`. A Tauri-command
// wrapper around the existing `rpc::request(&rpc.dom, …)` machinery
// will surface the tree to this component in a later phase. For now we
// render a placeholder that documents the chosen strategy so a future
// implementer doesn't relitigate the bridge-vs-injection choice.

function DomInspectorPlaceholder({ paneId }: { paneId: string }) {
	return (
		<div className="flex h-full w-full flex-col gap-2 overflow-y-auto p-4 font-mono text-[11px] leading-relaxed text-muted-foreground">
			<div className="text-[10px] uppercase tracking-[0.16em] text-foreground/80">
				DOM inspector
			</div>
			<div>
				The iyke iframe bridge already injects per-pane DOM tree access via the viewer server. A
				read-only tree view + element-click → comment-chip handoff lands in a follow-up alongside
				the wider pin-routing tidy-up (Phase 4).
			</div>
			<div className="text-muted-foreground/70">pane: {paneId}</div>
		</div>
	);
}

// ─── Chrome ──────────────────────────────────────────────────────────

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
				<ChromeButton onClick={onPromote} title="Promote to folder…" aria-label="Promote to folder">
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
				'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent'
			)}
		>
			{children}
		</button>
	);
}

// ─── Engine-write sync (lifted from studio-pane.tsx) ─────────────────

function useEngineWriteSync(path: string, onWrite: (nextSource: string) => void) {
	const onWriteRef = useRef(onWrite);
	onWriteRef.current = onWrite;

	useEffect(() => {
		const threadId = getOrMintStudioThreadId(path);
		const processedIds = new Set<string>();

		const unsubscribe = useChatStore.subscribe((state) => {
			const events = state.threads[threadId]?.events;
			if (!events || events.length === 0) return;

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
							new Uint8Array(res.bytes)
						);
						onWriteRef.current(text);
					})
					.catch(() => {
						// Best-effort — iframe fs_watch still reloads.
					});
			}
		});

		return () => {
			unsubscribe();
		};
	}, [path]);
}

function toToolUse(
	e: unknown
): { kind: 'tool_use'; id: string; name: string; input: unknown } | null {
	if (!e || typeof e !== 'object') return null;
	const ev = e as { kind?: unknown; id?: unknown; name?: unknown; input?: unknown };
	if (ev.kind !== 'tool_use' || typeof ev.id !== 'string' || typeof ev.name !== 'string') {
		return null;
	}
	return { kind: 'tool_use', id: ev.id, name: ev.name, input: ev.input };
}
