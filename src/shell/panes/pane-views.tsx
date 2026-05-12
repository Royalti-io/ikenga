import { type PaneView } from '@/lib/panes/types';
import { RouteView } from './views/route-view';
import { TerminalView } from './views/terminal-view';
import { ChatView } from './views/chat-view';
import { ArtifactView } from './views/artifact-view';

interface PaneBodyProps {
	paneId: string;
	view: PaneView;
}

export function PaneBody({ paneId, view }: PaneBodyProps) {
	switch (view.kind) {
		case 'route':
			return <RouteView paneId={paneId} path={view.path} />;
		case 'terminal':
			return <TerminalView sessionId={view.sessionId} />;
		case 'chat':
			return <ChatView sessionId={view.sessionId} />;
		case 'artifact':
			return <ArtifactView path={view.path} paneId={paneId} />;
	}
}

export function viewLabel(view: PaneView): string {
	switch (view.kind) {
		case 'route': {
			const segs = view.path.split('/').filter(Boolean);
			if (segs.length === 0) return 'Dashboard';
			return segs[segs.length - 1].replace(/-/g, ' ');
		}
		case 'terminal':
			return 'Terminal';
		case 'chat':
			return 'Chat';
		case 'artifact': {
			const name = view.path.split('/').filter(Boolean).pop();
			return name ?? 'Artifact';
		}
	}
}

export function viewSubtitle(view: PaneView): string {
	switch (view.kind) {
		case 'route':
			return view.path || '/';
		case 'terminal':
			return `session: ${view.sessionId}`;
		case 'chat':
			return `session: ${view.sessionId}`;
		case 'artifact':
			return view.path;
	}
}
