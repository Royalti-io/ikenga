import { useEffect, useRef, useState, useCallback } from 'react';
import {
  ChevronRight,
  ChevronDown,
  Folder,
  FileText,
  AlertCircle,
  RefreshCw,
  Pencil,
  Trash2,
} from 'lucide-react';
import { useShellStore } from '@/lib/shell/shell-store';
import { usePaneStore } from '@/lib/panes/pane-store';
import { fsList, fsRename, fsTrash, type FileEntry } from '@/lib/tauri-cmd';
import { cn } from '@/components/ui/utils';

const MAX_DEPTH = 4;

function sortEntries(list: FileEntry[]): FileEntry[] {
  const filtered = list.filter((e) => !e.name.startsWith('.'));
  filtered.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return filtered;
}

interface TreeNodeProps {
  entry: FileEntry;
  depth: number;
  onSelect: (path: string) => void;
  selectedPath: string | null;
  onSiblingsChanged: () => void;
}

function TreeNode({ entry, depth, onSelect, selectedPath, onSiblingsChanged }: TreeNodeProps) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<FileEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(entry.name);
  const [actionError, setActionError] = useState<string | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  const isAtDepthCap = depth >= MAX_DEPTH;
  const isSelected = selectedPath === entry.path;

  const loadChildren = useCallback(async () => {
    try {
      const list = await fsList(entry.path);
      setChildren(sortEntries(list));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [entry.path]);

  const handleClick = useCallback(async () => {
    if (renaming) return;
    if (entry.isDir) {
      if (isAtDepthCap) return;
      const next = !expanded;
      setExpanded(next);
      if (next && children === null) {
        await loadChildren();
      }
    } else {
      onSelect(entry.path);
    }
  }, [entry, expanded, children, isAtDepthCap, onSelect, renaming, loadChildren]);

  const startRename = useCallback(() => {
    setRenameValue(entry.name);
    setActionError(null);
    setRenaming(true);
  }, [entry.name]);

  useEffect(() => {
    if (renaming) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [renaming]);

  const commitRename = useCallback(async () => {
    const next = renameValue.trim();
    if (!next || next === entry.name) {
      setRenaming(false);
      return;
    }
    try {
      await fsRename(entry.path, next);
      setRenaming(false);
      onSiblingsChanged();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }, [renameValue, entry.path, entry.name, onSiblingsChanged]);

  const handleDelete = useCallback(async () => {
    const ok = window.confirm(`Move "${entry.name}" to trash?`);
    if (!ok) return;
    try {
      await fsTrash(entry.path);
      onSiblingsChanged();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }, [entry.path, entry.name, onSiblingsChanged]);

  const handleRefresh = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!entry.isDir || isAtDepthCap) return;
      if (!expanded) setExpanded(true);
      await loadChildren();
    },
    [entry.isDir, isAtDepthCap, expanded, loadChildren],
  );

  return (
    <div>
      <div
        className={cn(
          'group/row relative flex w-full items-center text-xs transition-colors',
          'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
          isSelected && 'bg-accent text-accent-foreground font-medium',
        )}
      >
        <button
          type="button"
          onClick={handleClick}
          className="flex min-w-0 flex-1 items-center gap-1 px-2 py-1 text-left"
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
          title={entry.path}
        >
          {entry.isDir ? (
            isAtDepthCap ? (
              <span className="h-3 w-3 shrink-0" aria-hidden />
            ) : expanded ? (
              <ChevronDown className="h-3 w-3 shrink-0" />
            ) : (
              <ChevronRight className="h-3 w-3 shrink-0" />
            )
          ) : (
            <span className="h-3 w-3 shrink-0" aria-hidden />
          )}
          {entry.isDir ? (
            <Folder className="h-3.5 w-3.5 shrink-0" />
          ) : (
            <FileText className="h-3.5 w-3.5 shrink-0" />
          )}
          {renaming ? (
            <input
              ref={renameInputRef}
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void commitRename();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  setRenaming(false);
                }
              }}
              onBlur={() => void commitRename()}
              className="w-full min-w-0 rounded border border-border bg-background px-1 py-0 text-xs text-foreground outline-none focus:border-ring"
            />
          ) : (
            <span className="truncate">{entry.name}</span>
          )}
        </button>
        {!renaming && (
          <div className="absolute right-1 top-1/2 hidden -translate-y-1/2 items-center gap-0.5 rounded bg-accent pl-1 group-hover/row:flex">
            {entry.isDir && !isAtDepthCap && (
              <button
                type="button"
                onClick={handleRefresh}
                className="rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
                title="Refresh"
                aria-label="Refresh"
              >
                <RefreshCw className="h-3 w-3" />
              </button>
            )}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                startRename();
              }}
              className="rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
              title="Rename"
              aria-label="Rename"
            >
              <Pencil className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                void handleDelete();
              }}
              className="rounded p-0.5 text-muted-foreground hover:bg-background hover:text-destructive"
              title="Move to trash"
              aria-label="Move to trash"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        )}
      </div>
      {actionError && (
        <div
          className="flex items-start gap-1 px-2 py-1 text-xs text-destructive"
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
        >
          <AlertCircle className="h-3 w-3 shrink-0 mt-0.5" />
          <span className="truncate" title={actionError}>
            {actionError}
          </span>
        </div>
      )}
      {entry.isDir && expanded && (
        <div>
          {error && (
            <div
              className="flex items-start gap-1 px-2 py-1 text-xs text-destructive"
              style={{ paddingLeft: `${(depth + 1) * 12 + 8}px` }}
            >
              <AlertCircle className="h-3 w-3 shrink-0 mt-0.5" />
              <span className="truncate" title={error}>
                {error}
              </span>
            </div>
          )}
          {children?.map((child) => (
            <TreeNode
              key={child.path}
              entry={child}
              depth={depth + 1}
              onSelect={onSelect}
              selectedPath={selectedPath}
              onSiblingsChanged={loadChildren}
            />
          ))}
          {children && children.length === 0 && !error && (
            <div
              className="px-2 py-1 text-xs text-muted-foreground italic"
              style={{ paddingLeft: `${(depth + 1) * 12 + 8}px` }}
            >
              empty
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface RootSectionProps {
  rootPath: string;
  onSelect: (path: string) => void;
  selectedPath: string | null;
}

function RootSection({ rootPath, onSelect, selectedPath }: RootSectionProps) {
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setEntries(null);
    setError(null);
    fsList(rootPath)
      .then((list) => {
        if (cancelled) return;
        setEntries(sortEntries(list));
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [rootPath, reloadTick]);

  const reload = useCallback(() => setReloadTick((t) => t + 1), []);

  const displayName = rootPath.replace(/^.+\//, '') || rootPath;

  return (
    <div className="border-b border-border last:border-b-0">
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-background px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {displayName}
          </span>
        </div>
        <button
          type="button"
          onClick={reload}
          className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          title={`Reload ${rootPath}`}
          aria-label="Reload"
        >
          <RefreshCw className="h-3 w-3" />
        </button>
      </div>
      {error && (
        <div className="flex items-start gap-1 px-3 py-1 text-xs text-destructive">
          <AlertCircle className="h-3 w-3 shrink-0 mt-0.5" />
          <span className="break-all" title={error}>
            {error}
          </span>
        </div>
      )}
      {!entries && !error && (
        <div className="px-3 py-1 text-xs text-muted-foreground italic">loading…</div>
      )}
      {entries?.map((entry) => (
        <TreeNode
          key={entry.path}
          entry={entry}
          depth={0}
          onSelect={onSelect}
          selectedPath={selectedPath}
          onSiblingsChanged={reload}
        />
      ))}
    </div>
  );
}

export function FilesMode() {
  const fileRoots = useShellStore((s) => s.fileRoots);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  // Click on a file → open it as an artifact tab in the focused pane.
  // `selectedPath` drives the active-row highlight; the file content is
  // rendered by ArtifactView inside the pane.
  const openFile = useCallback((path: string) => {
    setSelectedPath(path);
    const focusedId = usePaneStore.getState().focusedId;
    usePaneStore.getState().addTab(focusedId, { kind: 'artifact', path });
  }, []);

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto">
        {fileRoots.length === 0 && (
          <div className="p-4 text-xs text-muted-foreground">
            No file roots configured. Add one from{' '}
            <span className="font-medium text-foreground">Settings</span>.
          </div>
        )}
        {fileRoots.map((root) => (
          <RootSection
            key={root}
            rootPath={root}
            onSelect={openFile}
            selectedPath={selectedPath}
          />
        ))}
      </div>
    </div>
  );
}
