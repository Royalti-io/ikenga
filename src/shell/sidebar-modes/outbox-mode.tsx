import { Send, Newspaper, Share2, ListOrdered } from 'lucide-react';
import { usePaneStore } from '@/lib/panes/pane-store';
import { findLeaf } from '@/lib/panes/pane-reducer';
import { cn } from '@/components/ui/utils';

interface OutboxNavItem {
  to: string;
  label: string;
  Icon: typeof Send;
}

// Channels are first-class entries; views (queue/schedule/sent) are inner tabs
// inside each channel. There is no top-level "Sent" — cross-channel rollup is
// parked at /reports/outbox.
const OUTBOX_NAV: OutboxNavItem[] = [
  { to: '/outbox/email', label: 'Email', Icon: Send },
  { to: '/outbox/newsletter', label: 'Newsletter', Icon: Newspaper },
  { to: '/outbox/social', label: 'Social', Icon: Share2 },
  { to: '/outbox/sequences', label: 'Sequences', Icon: ListOrdered },
];

export function OutboxMode() {
  const navigateFocused = usePaneStore((s) => s.navigateFocused);
  const activePath = usePaneStore((s) => {
    const leaf = findLeaf(s.root, s.focusedId);
    if (!leaf) return null;
    const tab = leaf.tabs[leaf.activeTabIdx];
    return tab && tab.kind === 'route' ? tab.path : null;
  });

  return (
    <div className="h-full overflow-y-auto py-2">
      <div className="px-4 pb-1 pt-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
        Channels
      </div>
      <ul className="flex flex-col">
        {OUTBOX_NAV.map(({ to, label, Icon }) => {
          const isActive = activePath === to || activePath?.startsWith(`${to}/`) === true;
          return (
            <li key={to}>
              <button
                type="button"
                onClick={() => navigateFocused(to)}
                className={cn(
                  'flex w-full items-center gap-3 px-4 py-1.5 text-left text-sm transition-colors',
                  'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                  isActive && 'bg-accent text-accent-foreground font-medium',
                )}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span className="truncate">{label}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
