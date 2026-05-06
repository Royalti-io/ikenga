import { RefreshCw, SplitSquareHorizontal, SplitSquareVertical, X } from 'lucide-react';
import { type PaneId } from '@/lib/panes/types';
import { usePaneStore } from '@/lib/panes/pane-store';
import { cn } from '@/components/ui/utils';

interface PaneToolbarProps {
  paneId: PaneId;
}

export function PaneToolbar({ paneId }: PaneToolbarProps) {
  const splitPane = usePaneStore((s) => s.splitPane);
  const closePane = usePaneStore((s) => s.closePane);
  const refreshPane = usePaneStore((s) => s.refreshPane);
  const canSplit = usePaneStore((s) => s.canSplit());
  const leafCount = usePaneStore((s) => s.leafCount());

  const splitDisabled = !canSplit;
  const splitTitle = splitDisabled ? 'Max 6 panes' : undefined;
  const closeDisabled = leafCount <= 1;

  return (
    <div className="flex items-center gap-0.5">
      <ToolButton
        onClick={() => refreshPane(paneId)}
        title="Refresh pane content"
        aria-label="Refresh pane"
      >
        <RefreshCw className="h-3.5 w-3.5" />
      </ToolButton>
      <ToolButton
        onClick={() => splitPane(paneId, 'horizontal')}
        disabled={splitDisabled}
        title={splitTitle ?? 'Split right (⌘\\)'}
        aria-label="Split right"
      >
        <SplitSquareHorizontal className="h-3.5 w-3.5" />
      </ToolButton>
      <ToolButton
        onClick={() => splitPane(paneId, 'vertical')}
        disabled={splitDisabled}
        title={splitTitle ?? 'Split down (⌘⇧\\)'}
        aria-label="Split down"
      >
        <SplitSquareVertical className="h-3.5 w-3.5" />
      </ToolButton>
      <ToolButton
        onClick={() => closePane(paneId)}
        disabled={closeDisabled}
        title={closeDisabled ? 'Cannot close last pane' : 'Close pane'}
        aria-label="Close pane"
      >
        <X className="h-3.5 w-3.5" />
      </ToolButton>
    </div>
  );
}

interface ToolButtonProps {
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  'aria-label': string;
  children: React.ReactNode;
}

function ToolButton({ onClick, disabled, title, children, ...rest }: ToolButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={rest['aria-label']}
      className={cn(
        'flex h-6 w-6 items-center justify-center rounded',
        'text-muted-foreground transition-colors',
        'hover:bg-accent hover:text-accent-foreground',
        'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent',
      )}
    >
      {children}
    </button>
  );
}
