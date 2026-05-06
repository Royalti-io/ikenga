import { AlertCircle, RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/utils';
import { useMboxSyncStatus } from '@/lib/mbox/use-mbox-sync';

function relativeTime(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 30) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function MboxSyncIndicator({ className }: { className?: string }) {
  const status = useMboxSyncStatus();

  const lastSyncIso = status.state?.lastSyncIso ?? null;
  const lastInserted = status.lastResult?.inserted ?? status.state?.lastInserted ?? null;

  return (
    <div className={cn('flex items-center gap-3 text-xs', className)}>
      <div className="flex flex-col items-end leading-tight">
        <span className="text-muted-foreground">
          {status.isSyncing
            ? 'Syncing mailboxes…'
            : lastSyncIso
              ? `Synced ${relativeTime(lastSyncIso)}`
              : 'Not yet synced'}
        </span>
        {!status.isSyncing && lastInserted !== null && (
          <span className="text-[10px] text-muted-foreground/70">
            {lastInserted === 0
              ? 'no new messages'
              : `+${lastInserted} new ${lastInserted === 1 ? 'message' : 'messages'}`}
          </span>
        )}
      </div>

      <Button
        variant="outline"
        size="sm"
        onClick={() => void status.triggerSync()}
        disabled={status.isSyncing}
        className="h-7 gap-1.5 px-2 text-xs"
      >
        <RefreshCw
          className={cn('h-3 w-3', status.isSyncing && 'animate-spin')}
        />
        Sync now
      </Button>

      {status.lastError && !status.isSyncing && (
        <div
          className="flex max-w-[20rem] items-start gap-1 text-[11px] text-destructive"
          title={status.lastError}
        >
          <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
          <span className="truncate">{status.lastError}</span>
        </div>
      )}
    </div>
  );
}
