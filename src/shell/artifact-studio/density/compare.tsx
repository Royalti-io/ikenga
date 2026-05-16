// Compare density — two artifacts side by side.
//
// Layout: header chrome / [left renderer | right renderer | right rail] /
//   footer with swap + close-left + close-right + per-side promote.
//
// Right rail is Chat-only at compare density (per the unified plan;
// Code / DOM / Manifest need a single focused artifact — open either
// side in loupe to use them).

import { useCallback, useMemo, useState } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { ArrowLeftRight, GitCompare, X } from 'lucide-react';
import { cn } from '@/components/ui/utils';
import { fsRename } from '@/lib/tauri-cmd';
import { usePaneStore } from '@/lib/panes/pane-store';
import { pickRenderer } from '@/shell/artifact-studio/renderers';
import { RightRail, useRightRailTab } from '@/shell/artifact-studio/right-rail';
import { StudioFolderChat } from '@/shell/artifact-studio/studio-folder-chat';

interface StudioCompareProps {
	paneId: string;
	a: string;
	b: string;
}

function dirname(path: string): string {
	const slash = path.lastIndexOf('/');
	return slash >= 0 ? path.slice(0, slash) : '.';
}

function basename(path: string): string {
	const slash = path.lastIndexOf('/');
	return slash >= 0 ? path.slice(slash + 1) : path;
}

export function StudioCompare({ paneId, a, b }: StudioCompareProps) {
	const replaceView = usePaneStore((s) => s.replaceActiveViewAndPushHistory);
	const [rightTab, setRightTab] = useRightRailTab('chat');
	// Local swap — flipping the slots is purely presentational; the
	// canonical / variant promotion has its own button that renames on
	// disk. `swapped: true` renders `b` on the left and `a` on the right.
	const [swapped, setSwapped] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const [left, right] = swapped ? [b, a] : [a, b];

	// Folder context for the chat thread. Compare typically spans
	// variants of the same artifact, so both sides share a folder.
	// When they don't (cross-folder compare), prefer the left side's
	// folder — chat threads are keyed per folder by D3.
	const folderPath = useMemo(() => dirname(left), [left]);

	const LeftRenderer = useMemo(() => pickRenderer(left).Component, [left]);
	const RightRenderer = useMemo(() => pickRenderer(right).Component, [right]);

	const onSwap = useCallback(() => setSwapped((v) => !v), []);

	const onCloseLeft = useCallback(() => {
		replaceView(paneId, { kind: 'artifact-studio', path: right, density: 'loupe' });
	}, [paneId, right, replaceView]);
	const onCloseRight = useCallback(() => {
		replaceView(paneId, { kind: 'artifact-studio', path: left, density: 'loupe' });
	}, [paneId, left, replaceView]);

	// Promote a side to canonical via a three-step swap on disk. The
	// canonical name is taken to be the shorter of the two basenames —
	// if neither side carries a `-vN` suffix, prefer the first side's
	// name. Aborts on the first error; never partially leaves you with
	// two files named the same thing.
	const onMakeCanonical = useCallback(
		async (variantPath: string, canonicalPath: string) => {
			if (variantPath === canonicalPath) return;
			setBusy(true);
			setError(null);
			try {
				const dir = dirname(canonicalPath);
				const canonicalName = basename(canonicalPath);
				const variantName = basename(variantPath);
				// 3-step move via a temp basename in the same dir:
				//   1) canonical → temp
				//   2) variant   → canonical
				//   3) temp      → variantName
				const tempName = `.${canonicalName}.swap-${Date.now()}`;
				const tempPath = `${dir}/${tempName}`;

				await fsRename(canonicalPath, tempName);
				await fsRename(variantPath, canonicalName);
				await fsRename(tempPath, variantName);

				// After the swap: the file at `canonicalPath` is now the
				// promoted variant. Open it in compare against the demoted
				// (formerly canonical) sibling, so the user can review what
				// they just did.
				replaceView(paneId, {
					kind: 'artifact-studio',
					path: canonicalPath,
					density: 'compare',
					vs: variantPath,
				});
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e));
			} finally {
				setBusy(false);
			}
		},
		[paneId, replaceView]
	);

	return (
		<div className="flex h-full w-full flex-col bg-background" data-pane-id={paneId}>
			<div className="flex shrink-0 items-center gap-2 border-b border-border bg-muted/20 px-3 py-1.5 text-xs">
				<GitCompare className="h-3.5 w-3.5 text-muted-foreground" />
				<span className="font-mono">{basename(left)}</span>
				<span className="text-muted-foreground">↔</span>
				<span className="font-mono">{basename(right)}</span>
				<span className="ml-auto flex items-center gap-1">
					<HeaderButton onClick={onSwap} title="Swap sides" aria-label="Swap left and right">
						<ArrowLeftRight className="h-3.5 w-3.5" />
					</HeaderButton>
				</span>
			</div>
			<div className="flex-1 min-h-0 overflow-hidden">
				<PanelGroup direction="horizontal" autoSaveId={`studio-compare:${a}|${b}`}>
					<Panel defaultSize={70} minSize={30}>
						<PanelGroup direction="horizontal" autoSaveId={`studio-compare-split:${a}|${b}`}>
							<Panel defaultSize={50} minSize={20}>
								<ComparePane
									path={left}
									Renderer={LeftRenderer}
									paneId={paneId}
									sideLabel="left"
									onClose={onCloseLeft}
									onPromote={() => onMakeCanonical(left, right)}
									promoteDisabled={busy || left === right}
								/>
							</Panel>
							<PanelResizeHandle className="w-px bg-border hover:bg-accent" />
							<Panel defaultSize={50} minSize={20}>
								<ComparePane
									path={right}
									Renderer={RightRenderer}
									paneId={paneId}
									sideLabel="right"
									onClose={onCloseRight}
									onPromote={() => onMakeCanonical(right, left)}
									promoteDisabled={busy || left === right}
								/>
							</Panel>
						</PanelGroup>
					</Panel>
					<PanelResizeHandle className="w-px bg-border hover:bg-accent" />
					<Panel defaultSize={30} minSize={20}>
						<RightRail
							tab={rightTab}
							onChangeTab={setRightTab}
							slots={{ chat: <StudioFolderChat folderPath={folderPath} /> }}
						/>
					</Panel>
				</PanelGroup>
			</div>
			{error && (
				<div className="shrink-0 border-t border-destructive/40 bg-destructive/10 px-3 py-1.5 font-mono text-[10px] text-destructive">
					promote failed: {error}
				</div>
			)}
		</div>
	);
}

interface ComparePaneProps {
	path: string;
	Renderer: React.ComponentType<{
		path: string;
		paneId: string;
		density: 'grid' | 'loupe' | 'compare';
		source?: 'pane';
	}>;
	paneId: string;
	sideLabel: 'left' | 'right';
	onClose: () => void;
	onPromote: () => void;
	promoteDisabled: boolean;
}

function ComparePane({
	path,
	Renderer,
	paneId,
	sideLabel,
	onClose,
	onPromote,
	promoteDisabled,
}: ComparePaneProps) {
	return (
		<div className="flex h-full w-full flex-col">
			<div className="flex shrink-0 items-center gap-1.5 border-b border-border bg-muted/10 px-2 py-1 text-xs">
				<span className="font-mono text-foreground/80">{basename(path)}</span>
				<span className="ml-auto flex items-center gap-1">
					<button
						type="button"
						onClick={onPromote}
						disabled={promoteDisabled}
						title="Promote this side to canonical (swaps filenames on disk)"
						className={cn(
							'rounded border border-border px-1.5 py-0.5 font-mono text-[10px] transition-colors',
							'text-muted-foreground hover:border-foreground/40 hover:text-foreground',
							'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-border disabled:hover:text-muted-foreground'
						)}
					>
						◉ make canonical
					</button>
					<HeaderButton
						onClick={onClose}
						title={`Close ${sideLabel} side (drop to loupe on the other)`}
						aria-label={`Close ${sideLabel} side`}
					>
						<X className="h-3.5 w-3.5" />
					</HeaderButton>
				</span>
			</div>
			<div className="flex-1 min-h-0">
				<Renderer path={path} paneId={paneId} density="compare" source="pane" />
			</div>
		</div>
	);
}

interface HeaderButtonProps {
	onClick: () => void;
	title?: string;
	'aria-label': string;
	children: React.ReactNode;
}

function HeaderButton({ onClick, title, children, ...rest }: HeaderButtonProps) {
	return (
		<button
			type="button"
			onClick={onClick}
			title={title}
			aria-label={rest['aria-label']}
			className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
		>
			{children}
		</button>
	);
}
