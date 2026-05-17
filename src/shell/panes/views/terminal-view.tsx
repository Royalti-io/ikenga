// Side-pane Terminal panel entry point.
//
// Gates ownership: if the tab is currently attached to an Artifact Studio
// loupe, the side pane keeps its tab strip entry but the panel body shows
// a placeholder pointing at the owning Studio (D4). `SingleTerminal` stays
// ownership-agnostic so Studio can mount it directly without the gate.

import { ExternalLink, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SingleTerminal } from '@/terminal/single-terminal';
import { useTerminalStore, type TerminalTab } from '@/terminal/session-store';
import { usePaneStore } from '@/lib/panes/pane-store';

interface TerminalViewProps {
	sessionId: string;
}

export function TerminalView({ sessionId }: TerminalViewProps) {
	const tab = useTerminalStore((s) => s.tabs.find((t) => t.id === sessionId));
	if (tab && tab.owner.kind === 'studio') {
		const ownerPaneId = tab.owner.paneId;
		return (
			<StudioOwnedPlaceholder
				tab={tab}
				paneId={ownerPaneId}
				artifactPath={tab.owner.artifactPath}
				onReclaim={() => useTerminalStore.getState().detachFromStudio(sessionId)}
				onOpenStudio={() => usePaneStore.getState().focusPane(ownerPaneId)}
			/>
		);
	}
	return (
		<div className="h-full w-full">
			<SingleTerminal sessionId={sessionId} />
		</div>
	);
}

interface StudioOwnedPlaceholderProps {
	tab: TerminalTab;
	paneId: string;
	artifactPath: string;
	onReclaim: () => void;
	onOpenStudio: () => void;
}

function StudioOwnedPlaceholder({
	tab,
	paneId,
	artifactPath,
	onReclaim,
	onOpenStudio,
}: StudioOwnedPlaceholderProps) {
	const filename = artifactPath.split('/').filter(Boolean).pop() ?? artifactPath;
	return (
		<div className="flex h-full w-full flex-col items-center justify-center gap-3 p-6 text-center">
			<div className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
				In Studio · pane {paneId.slice(0, 6)}
			</div>
			<div className="text-sm text-foreground">{tab.title}</div>
			<div className="font-mono text-[11px] text-muted-foreground" title={artifactPath}>
				attached to {filename}
			</div>
			<div className="mt-2 flex items-center gap-2">
				<Button size="sm" variant="outline" onClick={onOpenStudio} className="h-7 px-3 text-xs">
					<ExternalLink className="mr-1 h-3 w-3" />
					Open Studio
				</Button>
				<Button size="sm" onClick={onReclaim} className="h-7 px-3 text-xs">
					<Undo2 className="mr-1 h-3 w-3" />
					Reclaim
				</Button>
			</div>
		</div>
	);
}
