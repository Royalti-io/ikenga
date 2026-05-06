/**
 * Static "Claude CLI" badge — switching is deferred until a second adapter
 * exists. Keeping the slot in the layout so the future switcher drops in.
 */

import { Zap } from 'lucide-react';
import { cn } from '@/components/ui/utils';

export function AdapterSwitcher({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2 py-1 text-[11px] font-medium',
        className,
      )}
      title="Adapter switching is deferred until a second adapter ships (post-v1)."
    >
      <Zap className="h-3 w-3 text-amber-500" />
      Claude CLI
    </span>
  );
}
