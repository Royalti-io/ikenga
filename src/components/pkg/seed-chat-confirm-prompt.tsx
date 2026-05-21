// Modal that surfaces a pkg's seed prompt for approval before
// `host.startChatSession` sends it to an engine. Renders only when
// `useSeedChatConfirmStore.pending` is set — the host verb posts there and
// awaits the user's decision.
//
// Mounted once at the workspace root so it survives pane navigation and the
// lifetime of any pkg iframe that requested the session.

import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useSeedChatConfirmStore } from '@/components/pkg/seed-chat-confirm-store';

export function SeedChatConfirmPrompt() {
	const pending = useSeedChatConfirmStore((s) => s.pending);
	const settle = useSeedChatConfirmStore((s) => s.settle);

	if (!pending) return null;

	return (
		<Dialog open onOpenChange={(o) => !o && settle(false)}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Start a chat session?</DialogTitle>
					<DialogDescription>
						<code className="font-mono text-foreground">{pending.pkgId}</code> wants to open a new
						chat session seeded with the prompt below. Review it before it's sent to the engine.
					</DialogDescription>
				</DialogHeader>

				{pending.title && (
					<div className="text-xs text-muted-foreground">
						Session title: <span className="text-foreground">{pending.title}</span>
					</div>
				)}

				<pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/40 p-3 text-xs text-foreground">
					{pending.prompt}
				</pre>

				<DialogFooter>
					<Button variant="outline" onClick={() => settle(false)}>
						Cancel
					</Button>
					<Button onClick={() => settle(true)}>Send to engine</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
