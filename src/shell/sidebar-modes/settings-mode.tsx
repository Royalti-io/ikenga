import { HardDrive, Info, Package, Palette, Plug, type LucideIcon } from 'lucide-react';

import { usePaneStore } from '@/lib/panes/pane-store';
import { findLeaf } from '@/lib/panes/pane-reducer';
import { cn } from '@/components/ui/utils';

interface NavItem {
  to: string;
  label: string;
  Icon: LucideIcon;
}

interface NavSection {
  label: string;
  items: NavItem[];
}

const NAV: NavSection[] = [
  {
    label: 'Workspace',
    items: [
      { to: '/settings/appearance', label: 'Appearance', Icon: Palette },
      { to: '/settings/packages', label: 'Packages', Icon: Package },
    ],
  },
  {
    label: 'Integrations',
    items: [{ to: '/settings/integrations', label: 'Integrations', Icon: Plug }],
  },
  {
    label: 'Storage',
    items: [{ to: '/settings/storage', label: 'Storage', Icon: HardDrive }],
  },
  {
    label: 'Other',
    items: [{ to: '/settings/about', label: 'About', Icon: Info }],
  },
];

export function SettingsMode() {
  const navigateFocused = usePaneStore((s) => s.navigateFocused);
  const activePath = usePaneStore((s) => {
    const leaf = findLeaf(s.root, s.focusedId);
    if (!leaf) return null;
    const tab = leaf.tabs[leaf.activeTabIdx];
    return tab && tab.kind === 'route' ? tab.path : null;
  });

  return (
    <div className="h-full overflow-y-auto py-2">
      {NAV.map((sec) => (
        <div key={sec.label} className="mb-3">
          <div className="px-4 pb-1 pt-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
            {sec.label}
          </div>
          <ul className="flex flex-col">
            {sec.items.map(({ to, label, Icon }) => {
              const isActive =
                activePath === to || activePath?.startsWith(`${to}/`) === true;
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
      ))}
    </div>
  );
}
