import { FileOutput, ExternalLink } from 'lucide-react';
import { usePaneStore } from '@/lib/panes/pane-store';
import { cn } from '@/components/ui/utils';

interface ArtifactPillProps {
  path: string;
  mime: string;
  producedBy?: string;
}

function basename(p: string): string {
  return p.split('/').filter(Boolean).pop() ?? p;
}

export function ArtifactPill({ path, mime, producedBy }: ArtifactPillProps) {
  const focusedId = usePaneStore((s) => s.focusedId);
  const addTab = usePaneStore((s) => s.addTab);

  function handleOpen() {
    addTab(focusedId, { kind: 'artifact', path });
  }

  return (
    <button
      type="button"
      onClick={handleOpen}
      className={cn(
        'group inline-flex max-w-full items-center gap-2 rounded-full border border-violet-500/30 bg-violet-500/10 px-3 py-1 text-left',
        'transition-colors hover:border-violet-500/60 hover:bg-violet-500/20',
      )}
      title={path}
    >
      <FileOutput className="h-3 w-3 shrink-0 text-violet-700 dark:text-violet-300" />
      <span className="truncate font-mono text-[11px] text-foreground">{basename(path)}</span>
      <span className="shrink-0 text-[10px] text-muted-foreground">{mime}</span>
      {producedBy && (
        <span className="shrink-0 text-[10px] text-muted-foreground">via {producedBy}</span>
      )}
      <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100" />
    </button>
  );
}
