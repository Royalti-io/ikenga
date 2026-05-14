import { type PaneView } from '@/lib/panes/types';
import { type IkengaWorkspace } from '@/lib/ikenga/theme-store';

// Map a route prefix to its workspace tint. Post-strip, only shell-internal
// routes are admitted to the union; pkg routes (`/pkg/...`) all roll up to
// 'app'.
const ROUTE_PREFIXES: Array<[string, IkengaWorkspace]> = [
	['/sessions', 'sessions'],
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
		case 'scratchpad':
			return 'app';
	}
}
