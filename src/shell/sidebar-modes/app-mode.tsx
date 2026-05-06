import { NAV_GROUPS } from '../nav-config';
import { usePaneStore } from '@/lib/panes/pane-store';
import { findLeaf } from '@/lib/panes/pane-reducer';
import { cn } from '@/components/ui/utils';

export function AppMode() {
  const navigateFocused = usePaneStore((s) => s.navigateFocused);
  // Active highlight tracks the focused pane's active route view (if any).
  const activePath = usePaneStore((s) => {
    const leaf = findLeaf(s.root, s.focusedId);
    if (!leaf) return null;
    const tab = leaf.tabs[leaf.activeTabIdx];
    return tab && tab.kind === 'route' ? tab.path : null;
  });

  return (
    <div className="h-full overflow-y-auto py-2">
      {NAV_GROUPS.map((group, groupIdx) => (
        <div key={group.label ?? 'home'} className={groupIdx > 0 ? 'mt-3' : ''}>
          {group.label && (
            <div className="mb-1 px-4 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {group.label}
            </div>
          )}
          <ul className="flex flex-col">
            {group.items.map(({ to, label, Icon }) => {
              const isActive =
                activePath === null
                  ? false
                  : to === '/'
                    ? activePath === '/'
                    : activePath === to || activePath.startsWith(`${to}/`);
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
