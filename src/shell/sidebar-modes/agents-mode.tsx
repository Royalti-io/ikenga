import {
  Bot,
  ShieldCheck,
  ArrowRightLeft,
  UserCheck,
  Activity,
  Timer,
  FileBarChart,
  Settings as SettingsIcon,
  type LucideIcon,
} from 'lucide-react';
import { usePaneStore } from '@/lib/panes/pane-store';
import { findLeaf } from '@/lib/panes/pane-reducer';
import { cn } from '@/components/ui/utils';

interface ObservabilityItem {
  to: string;
  label: string;
  Icon: LucideIcon;
}

const OBSERVABILITY: ObservabilityItem[] = [
  { to: '/claude', label: 'Claude config', Icon: SettingsIcon },
  { to: '/approvals', label: 'Approvals', Icon: ShieldCheck },
  { to: '/delegations', label: 'Delegations', Icon: UserCheck },
  { to: '/handoffs', label: 'Handoffs', Icon: ArrowRightLeft },
  { to: '/agent-runs', label: 'Runs', Icon: Activity },
  { to: '/cron', label: 'Cron', Icon: Timer },
  { to: '/reports', label: 'Reports', Icon: FileBarChart },
];

const AGENTS: Array<{ key: string; name: string; description: string }> = [
  { key: 'cmo', name: 'CMO', description: 'Marketing, content, campaigns' },
  { key: 'cfo', name: 'CFO', description: 'Finance, runway, reconciliation' },
  { key: 'cpo', name: 'CPO', description: 'Product, roadmap, prioritization' },
  { key: 'cto', name: 'CTO', description: 'Engineering, architecture, debt' },
  { key: 'cbo', name: 'CBO', description: 'Partnerships, revenue strategy' },
  { key: 'sales', name: 'VP Sales', description: 'Pipeline, deals, forecasting' },
];

export function AgentsMode() {
  const navigateFocused = usePaneStore((s) => s.navigateFocused);
  const activePath = usePaneStore((s) => {
    const leaf = findLeaf(s.root, s.focusedId);
    if (!leaf) return null;
    const tab = leaf.tabs[leaf.activeTabIdx];
    return tab && tab.kind === 'route' ? tab.path : null;
  });

  return (
    <div className="h-full overflow-y-auto py-2">
      <div className="mb-1 px-4 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        Observability
      </div>
      <ul className="flex flex-col">
        {OBSERVABILITY.map(({ to, label, Icon }) => {
          const isActive =
            activePath === null
              ? false
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

      <div className="mt-3 mb-1 px-4 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        C-level personas
      </div>
      <div className="border-b border-border bg-muted/30 mx-3 mb-2 rounded-md px-3 py-2 text-xs text-muted-foreground">
        Agent-routed chat is not wired yet. Use <span className="font-mono">⌘⇧N</span> to start a
        fresh Claude session, or open one from the Sessions sidebar.
      </div>
      <ul className="flex flex-col">
        {AGENTS.map((agent) => (
          <li key={agent.key}>
            <div
              className="flex items-start gap-3 px-4 py-2 text-sm cursor-not-allowed opacity-70"
              title={`${agent.name} — agent routing not wired yet`}
            >
              <Bot className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="font-medium text-foreground">{agent.name}</div>
                <div className="text-xs text-muted-foreground line-clamp-2">
                  {agent.description}
                </div>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
