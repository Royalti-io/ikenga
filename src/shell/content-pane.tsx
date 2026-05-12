import { PaneTree } from './panes/pane-tree';

export function ContentPane() {
	return (
		<main className="flex h-full flex-col overflow-hidden bg-background">
			<PaneTree />
		</main>
	);
}
