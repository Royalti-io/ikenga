import { type PaneView } from '@/lib/panes/types';
import { type IkengaWorkspace } from '@/lib/ikenga/theme-store';

// Map a route prefix to its workspace tint. Order matters — check longest
// prefixes first when paths nest.
const ROUTE_PREFIXES: Array<[string, IkengaWorkspace]> = [
  ['/mail', 'mail'],
  ['/outbox', 'outbox'],
  ['/agent-runs', 'agents'],
  ['/agents', 'agents'],
  ['/claude', 'agents'],
  ['/sessions', 'sessions'],
  ['/cron', 'sessions'],
  ['/settings', 'settings'],
  ['/files', 'files'],
];

export function viewWorkspace(view: PaneView): IkengaWorkspace {
  switch (view.kind) {
    case 'route': {
      for (const [prefix, ws] of ROUTE_PREFIXES) {
        if (view.path === prefix || view.path.startsWith(`${prefix}/`)) return ws;
      }
      return 'app';
    }
    case 'terminal':
      return 'sessions';
    case 'chat':
      return 'sessions';
    case 'artifact':
      return 'files';
    case 'mini-app':
      return 'studio';
  }
}
