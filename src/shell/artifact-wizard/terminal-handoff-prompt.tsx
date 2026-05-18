// Modal asking whether to attach the wizard-spawned terminal to the
// freshly-opened Studio loupe, or keep it in its own right pane. Renders
// only when `useHandoffStore.pending` is set — the wizard's watcher posts
// to that store after swapping grid → loupe, but only if the user's
// persisted pref is `'ask'` (the default). The "Remember my choice"
// checkbox flips the pref so subsequent runs skip the modal.
//
// Mounted once at the workspace root so it survives wizard close and
// pane navigation.

import { useState } from 'react';

import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { applyHandoff, saveHandoffPref } from '@/shell/artifact-wizard/handoff-pref';
import { useHandoffStore } from '@/shell/artifact-wizard/handoff-store';

export function TerminalHandoffPrompt() {
	const pending = useHandoffStore((s) => s.pending);
	const resolve = useHandoffStore((s) => s.resolve);
	const [remember, setRemember] = useState(false);

	if (!pending) return null;

	const fileName = pending.artifactPath.replace(/^.+\//, '');

	function choose(action: 'attach' | 'keep') {
		if (!pending) return;
		applyHandoff(action, pending);
		if (remember) {
			void saveHandoffPref(action).catch((e) => {
				console.warn('[handoff] saveHandoffPref failed:', e);
			});
		}
		resolve();
	}

	return (
		<Dialog open onOpenChange={(o) => !o && resolve()}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Attach terminal to the loupe?</DialogTitle>
					<DialogDescription>
						The agent wrote <code className="font-mono text-foreground">{fileName}</code> and the
						Studio loupe is now open. Attach the terminal to the loupe's Chat tab (and close the
						right pane) or keep the terminal where it is.
					</DialogDescription>
				</DialogHeader>

				<label className="flex items-center gap-2 text-xs text-muted-foreground">
					<input
						type="checkbox"
						checked={remember}
						onChange={(e) => setRemember(e.target.checked)}
					/>
					Remember my choice (change later in Settings → Artifact grid)
				</label>

				<DialogFooter>
					<Button variant="outline" onClick={() => choose('keep')}>
						Keep separate
					</Button>
					<Button onClick={() => choose('attach')}>Attach</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
