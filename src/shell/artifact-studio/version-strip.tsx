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

/** Pure: given an artifact path and the file lists at its parent dir +
 *  variant subdir, return the ordered version set with the canonical
 *  pinned first. The opened path may itself be a variant — the canonical
 *  is recovered by stripping a trailing version suffix and checking the
 *  parent for `<stem><ext>`. */
export interface VersionEntry {
	path: string;
	name: string;
	isCanonical: boolean;
	modifiedMs: number;
	size: number;
}

/** Strip a trailing `-vN`, `_N`, or `-vN-descriptor` from a basename
 *  (without extension) to recover the version family's stem. Pure. */
export function versionStem(basenameNoExt: string): string {
	// `-v2`, `-v10`, `_3` — optionally followed by a `-descriptor` tail.
	const re = /^(.+?)[-_](?:v?\d+)(?:-[A-Za-z0-9_.-]+)?$/i;
	const m = re.exec(basenameNoExt);
	return m ? m[1] : basenameNoExt;
}

/** True when `candidate` is in the same version family as `stem`.
 *  Either the bare stem (canonical) or `<stem>(-vN | _N)(-descriptor)?`. */
function isFamilyMember(candidate: string, stem: string): boolean {
	if (candidate === stem) return true;
	if (!candidate.startsWith(stem)) return false;
	const rest = candidate.slice(stem.length);
	return /^[-_]v?\d+(-[A-Za-z0-9_.-]+)?$/i.test(rest);
}

export function computeVersions(
	openedPath: string,
	parentEntries: FileEntry[],
	variantSubEntries: FileEntry[]
): VersionEntry[] {
	const slash = openedPath.lastIndexOf('/');
	const openedName = slash >= 0 ? openedPath.slice(slash + 1) : openedPath;
	const parentDir = slash >= 0 ? openedPath.slice(0, slash) : '.';
	const dot = openedName.lastIndexOf('.');
	const openedBase = dot > 0 ? openedName.slice(0, dot) : openedName;
	const extension = dot > 0 ? openedName.slice(dot) : '';

	// Recover the canonical: <stem><ext> if it exists in the parent dir,
	// else the opened path itself is treated as canonical.
	const stem = versionStem(openedBase);
	const stemPath = `${parentDir}/${stem}${extension}`;
	const stemEntry = parentEntries.find((e) => !e.isDir && e.path === stemPath);
	const canonicalPath = stemEntry ? stemPath : openedPath;
	const canonicalName = stemEntry ? `${stem}${extension}` : openedName;
	const canonicalEntry =
		stemEntry ?? parentEntries.find((e) => !e.isDir && e.path === canonicalPath);

	const out: VersionEntry[] = [];
	const seen = new Set<string>();

	out.push({
		path: canonicalPath,
		name: canonicalName,
		isCanonical: true,
		modifiedMs: canonicalEntry?.modifiedMs ?? 0,
		size: canonicalEntry?.size ?? 0,
	});
	seen.add(canonicalPath);

	// Siblings in the same dir whose name is in the family. Same extension
	// required so `foo.html` doesn't pull in `foo-v2.md`.
	for (const e of parentEntries) {
		if (e.isDir) continue;
		if (seen.has(e.path)) continue;
		if (extension && !e.name.endsWith(extension)) continue;
		const eDot = e.name.lastIndexOf('.');
		const eBase = eDot > 0 ? e.name.slice(0, eDot) : e.name;
		if (!isFamilyMember(eBase, stem)) continue;
		out.push({
			path: e.path,
			name: e.name,
			isCanonical: false,
			modifiedMs: e.modifiedMs,
			size: e.size,
		});
		seen.add(e.path);
	}

	// Legacy convention: `<basename>/<variant>.html` next to the canonical.
	// Walked unconditionally — the variant subdir is named after the stem
	// so anything inside is presumed to belong.
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

/** Next free variant name for `<basename>-vN<ext>`. Pure for testability.
 *  `_N` and `-vN-descriptor` suffixes on the input are stripped so we
 *  always count against the bare family. */
export function nextVariantName(
	canonicalName: string,
	existingNames: ReadonlyArray<string>
): string {
	const dot = canonicalName.lastIndexOf('.');
	const basename = dot > 0 ? canonicalName.slice(0, dot) : canonicalName;
	const extension = dot > 0 ? canonicalName.slice(dot) : '';
	const family = versionStem(basename);
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
	const openedName = slash >= 0 ? path.slice(slash + 1) : path;
	const dot = openedName.lastIndexOf('.');
	const openedBase = dot > 0 ? openedName.slice(0, dot) : openedName;
	const extension = dot > 0 ? openedName.slice(dot) : '';
	// Recover the family stem so the legacy variant subdir (`<stem>/`) is
	// looked up by the same family the opened path belongs to — opening
	// `foo-v2.html` still pulls in variants from `foo/`.
	const stem = versionStem(openedBase);
	const canonicalName = `${stem}${extension}`;
	const variantSubDir = `${parentDir}/${stem}`;

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
										: 'bg-[var(--achievement)]/15 text-[var(--achievement)]'
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
