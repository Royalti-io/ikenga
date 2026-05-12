/**
 * Adapter switcher. Renders nothing while only one adapter is registered —
 * an UI affordance with no meaningful choices is just clutter. When a
 * second adapter ships, this becomes a real popover.
 */

import { Zap } from 'lucide-react';
import { cn } from '@/components/ui/utils';
import { listAdapters } from '../registry';

export function AdapterSwitcher({ className }: { className?: string }) {
  const adapters = listAdapters();
  if (adapters.length <= 1) return null;
  // Multi-adapter UX lands when there's a second adapter — until then this
  // path is unreachable. Keeping the badge as a sensible default.
  const active = adapters[0];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2 py-1 text-[11px] font-medium',
        className,
      )}
      title="Adapter"
    >
      <Zap className="h-3 w-3 text-amber-500" />
      {active.label}
    </span>
  );
}
