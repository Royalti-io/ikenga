import { Inbox, Filter, Mail, MailCheck } from 'lucide-react';
import { usePaneStore } from '@/lib/panes/pane-store';
import { findLeaf } from '@/lib/panes/pane-reducer';
import { cn } from '@/components/ui/utils';

interface MailNavItem {
  to: string;
  label: string;
  Icon: typeof Inbox;
}

const MAIL_NAV: MailNavItem[] = [
  { to: '/mail/inbox', label: 'Inbox', Icon: Inbox },
  { to: '/mail/triage', label: 'Triage', Icon: Filter },
  { to: '/mail/all', label: 'All Mail', Icon: Mail },
  { to: '/mail/drafts', label: 'Reply Drafts', Icon: MailCheck },
];

export function MailMode() {
  const navigateFocused = usePaneStore((s) => s.navigateFocused);
  const activePath = usePaneStore((s) => {
    const leaf = findLeaf(s.root, s.focusedId);
    if (!leaf) return null;
    const tab = leaf.tabs[leaf.activeTabIdx];
    return tab && tab.kind === 'route' ? tab.path : null;
  });

  return (
    <div className="h-full overflow-y-auto py-2">
      <ul className="flex flex-col">
        {MAIL_NAV.map(({ to, label, Icon }) => {
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
