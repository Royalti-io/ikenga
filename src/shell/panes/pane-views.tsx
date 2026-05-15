import type { PaneView } from '@/lib/panes/types';
import { RouteView } from './views/route-view';
import { TerminalView } from './views/terminal-view';
import { ChatView } from './views/chat-view';
import { ArtifactView } from './views/artifact-view';
import { ArtifactStudioView } from './views/artifact-studio-view';
import { ScratchpadView } from './views/scratchpad-view';
import { ToolOutputView } from './views/tool-output-view';

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
		case 'artifact-studio':
			return <ArtifactStudioView path={view.path} paneId={paneId} />;
		case 'scratchpad':
			return <ScratchpadView scope={view.scope} name={view.name} />;
		case 'tool-output':
			return <ToolOutputView threadId={view.threadId} toolUseId={view.toolUseId} />;
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
		case 'artifact-studio': {
			const name = view.path.split('/').filter(Boolean).pop();
			return `Studio · ${name ?? 'artifact'}`;
		}
		case 'scratchpad':
			return view.name;
		case 'tool-output':
			// Short id is enough — the pane subtitle carries the full toolUseId
			// for disambiguation when several viewers are open at once.
			return `Tool · ${view.toolUseId.slice(0, 8)}`;
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
		case 'artifact-studio':
			return view.path;
		case 'scratchpad':
			return view.scope;
		case 'tool-output':
			return `thread: ${view.threadId.slice(0, 8)}… · tool: ${view.toolUseId}`;
	}
}
