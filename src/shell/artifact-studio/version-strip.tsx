// Version strip — horizontal row of sibling files below the loupe
// preview. Built by `fsList(parentDir)` (sibling pattern matches) +
// `fsList(./<basename>/)` (older variant-in-subfolder convention).
//
// No git plumbing, no DB versioning. The filesystem is the version
// store, per locked decision D5 in the unified plan.

import { useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { cn } from '@/components/ui/utils';
import { commentList, fsList, fsRead, fsWrite, type FileEntry } from '@/lib/tauri-cmd';
import { usePaneStore } from '@/lib/panes/pane-store';

/** Pure: given a canonical artifact path and the file lists at its
 *  parent dir + variant subdir, return the ordered version set with
 *  the canonical pinned first. */
export interface VersionEntry {
	path: string;
	name: string;
	isCanonical: boolean;
	modifiedMs: number;
	size: number;
}

export function computeVersions(
	canonicalPath: string,
	parentEntries: FileEntry[],
	variantSubEntries: FileEntry[]
): VersionEntry[] {
	const slash = canonicalPath.lastIndexOf('/');
	const canonicalName = slash >= 0 ? canonicalPath.slice(slash + 1) : canonicalPath;
	const dot = canonicalName.lastIndexOf('.');
	const basename = dot > 0 ? canonicalName.slice(0, dot) : canonicalName;
	const extension = dot > 0 ? canonicalName.slice(dot) : '';

	const out: VersionEntry[] = [];
	const seen = new Set<string>();

	const canonicalEntry = parentEntries.find((e) => !e.isDir && e.path === canonicalPath);
	out.push({
		path: canonicalPath,
		name: canonicalName,
		isCanonical: true,
		modifiedMs: canonicalEntry?.modifiedMs ?? 0,
		size: canonicalEntry?.size ?? 0,
	});
	seen.add(canonicalPath);

	// Siblings in the same dir with `<basename>*<ext>` (e.g. `cfo-daily-v2.html`).
	for (const e of parentEntries) {
		if (e.isDir) continue;
		if (seen.has(e.path)) continue;
		if (!e.name.startsWith(basename)) continue;
		if (extension && !e.name.endsWith(extension)) continue;
		out.push({
			path: e.path,
			name: e.name,
			isCanonical: false,
			modifiedMs: e.modifiedMs,
			size: e.size,
		});
		seen.add(e.path);
	}

	// Older convention: `<basename>/<variant>.html` next to the canonical file.
	for (const e of variantSubEntries) {
		if (e.isDir) continue;
		if (seen.has(e.path)) continue;
		if (extension && !e.name.endsWith(extension)) continue;
		out.push({
			path: e.path,
			name: e.name,
			isCanonical: false,
			modifiedMs: e.modifiedMs,
			size: e.size,
		});
		seen.add(e.path);
	}

	// Variants sorted most-recently-modified first; canonical pinned at index 0.
	const head = out[0];
	const tail = out.slice(1).sort((a, b) => b.modifiedMs - a.modifiedMs);
	return [head, ...tail];
}

/** Next free variant name for `<basename>-vN<ext>`. Pure for testability. */
export function nextVariantName(
	canonicalName: string,
	existingNames: ReadonlyArray<string>
): string {
	const dot = canonicalName.lastIndexOf('.');
	const basename = dot > 0 ? canonicalName.slice(0, dot) : canonicalName;
	const extension = dot > 0 ? canonicalName.slice(dot) : '';
	// Strip any trailing `-vN` from the canonical so the new variant counts
	// against the family rather than chaining (v2 from `foo-v2.html` → `foo-v3.html`).
	const family = basename.replace(/-v\d+$/i, '');
	const taken = new Set(existingNames);
	let n = 2;
	while (taken.has(`${family}-v${n}${extension}`)) n += 1;
	return `${family}-v${n}${extension}`;
}

interface VersionStripProps {
	paneId: string;
	path: string;
}

export function VersionStrip({ paneId, path }: VersionStripProps) {
	const replaceActiveView = usePaneStore((s) => s.replaceActiveViewAndPushHistory);
	const slash = path.lastIndexOf('/');
	const parentDir = slash >= 0 ? path.slice(0, slash) : '.';
	const canonicalName = slash >= 0 ? path.slice(slash + 1) : path;
	const dot = canonicalName.lastIndexOf('.');
	const basename = dot > 0 ? canonicalName.slice(0, dot) : canonicalName;
	const variantSubDir = `${parentDir}/${basename}`;

	const parentQuery = useQuery({
		queryKey: ['artifact-studio', 'version-strip', 'parent', parentDir],
		queryFn: () => fsList(parentDir),
		staleTime: 2_000,
	});
	const variantQuery = useQuery({
		queryKey: ['artifact-studio', 'version-strip', 'variant', variantSubDir],
		queryFn: async () => {
			try {
				return await fsList(variantSubDir);
			} catch {
				return [] as FileEntry[];
			}
		},
		staleTime: 2_000,
	});

	const versions = useMemo(
		() => computeVersions(path, parentQuery.data ?? [], variantQuery.data ?? []),
		[path, parentQuery.data, variantQuery.data]
	);

	const pinsQuery = useQuery({
		queryKey: ['artifact-studio', 'version-strip', 'pins', versions.map((v) => v.path).join('|')],
		queryFn: async () => {
			const counts = new Map<string, { open: number; inProgress: number }>();
			for (const v of versions) {
				const list = await commentList({ artifactPath: v.path, includeResolved: false });
				counts.set(v.path, {
					open: list.filter((p) => p.status === 'open').length,
					inProgress: list.filter((p) => p.status === 'in_progress').length,
				});
			}
			return counts;
		},
		staleTime: 2_000,
		enabled: versions.length > 0,
	});

	const onPick = useCallback(
		(targetPath: string) => {
			if (targetPath === path) return;
			replaceActiveView(paneId, {
				kind: 'artifact-studio',
				path: targetPath,
				density: 'loupe',
			});
		},
		[paneId, path, replaceActiveView]
	);

	const onCompare = useCallback(
		(targetPath: string) => {
			if (targetPath === path) return;
			replaceActiveView(paneId, {
				kind: 'artifact-studio',
				path,
				density: 'compare',
				vs: targetPath,
			});
		},
		[paneId, path, replaceActiveView]
	);

	const onNew = useCallback(async () => {
		const existing = versions.map((v) => v.name);
		const newName = nextVariantName(canonicalName, existing);
		const newPath = `${parentDir}/${newName}`;
		try {
			const cur = await fsRead(path);
			await fsWrite(newPath, new Uint8Array(cur.bytes));
			replaceActiveView(paneId, {
				kind: 'artifact-studio',
				path: newPath,
				density: 'loupe',
			});
		} catch (e) {
			console.error('[version-strip] +new failed', e);
		}
	}, [canonicalName, parentDir, path, paneId, replaceActiveView, versions]);

	if (parentQuery.isLoading) {
		return (
			<div className="flex shrink-0 items-center border-t border-border bg-muted/10 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.10em] text-muted-foreground">
				versions: loading…
			</div>
		);
	}

	return (
		<div className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-t border-border bg-muted/10 px-3 py-1.5">
			<span className="mr-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
				versions:
			</span>
			{versions.map((v) => {
				const pins = pinsQuery.data?.get(v.path);
				const totalOpen = (pins?.open ?? 0) + (pins?.inProgress ?? 0);
				return (
					<button
						key={v.path}
						type="button"
						onClick={() => onPick(v.path)}
						onContextMenu={(e) => {
							e.preventDefault();
							if (!v.isCanonical) onCompare(v.path);
						}}
						title={
							v.isCanonical
								? 'canonical (right-click to open in compare → another sibling)'
								: 'click to open · right-click to compare with current'
						}
						className={cn(
							'flex items-center gap-1 rounded border px-2 py-0.5 font-mono text-[10px] transition-colors',
							v.isCanonical
								? 'border-foreground/40 bg-background text-foreground'
								: 'border-border text-muted-foreground hover:border-foreground/40 hover:text-foreground'
						)}
					>
						<span>{v.isCanonical ? '◉' : '○'}</span>
						<span className="truncate max-w-[160px]">{v.name}</span>
						{totalOpen > 0 && (
							<span
								className={cn(
									'rounded-full px-1.5 text-[9px]',
									(pins?.open ?? 0) > 0
										? 'bg-destructive/15 text-destructive'
										: 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
								)}
							>
								{totalOpen}
							</span>
						)}
					</button>
				);
			})}
			<button
				type="button"
				onClick={onNew}
				title="Branch a new variant from the current artifact"
				className="ml-1 flex items-center gap-0.5 rounded border border-dashed border-border px-2 py-0.5 font-mono text-[10px] text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground"
			>
				<Plus className="h-3 w-3" />
				new
			</button>
		</div>
	);
}
