// Workspace-mounted programmatic host for the New-Session dialog.
//
// Listens to `useOpenSessionDialogStore.pending` (set by
// `openSessionDialog()`, which is the verb-facing API). When something is
// pending, renders <NewSessionDialog> open + pre-filled with the requested
// args + an `onComplete` callback that settles the store. Same dialog
// component the sidebar's new-chat button and /sessions route already use —
// just driven programmatically here.
//
// Mounted ONCE at the workspace root (workspace.tsx) so the lifetime of the
// pending request is independent of any individual pane / route.

import { useOpenSessionDialogStore } from '@/components/pkg/open-session-dialog';
import {
	NewSessionDialog,
	type NewSessionDialogResult,
} from '@/shell/sessions/new-session-dialog';

export function OpenSessionDialogHost() {
	const pending = useOpenSessionDialogStore((s) => s.pending);
	const settle = useOpenSessionDialogStore((s) => s.settle);

	// Render nothing when idle so the dialog tree is fully unmounted between
	// programmatic opens. This guarantees the dialog's open-effect re-runs
	// (which resets `completedRef` and re-applies presets) on every request.
	if (!pending) return null;

	const handleComplete = (result: NewSessionDialogResult) => {
		// `scope-denied` is produced by the pkg-side dispatcher BEFORE we get
		// here, so the dialog only emits `chat | terminal | cancelled`. Map
		// straight through.
		settle(result);
	};

	return (
		<NewSessionDialog
			open
			// The dialog drives close through `onComplete` (Start → result;
			// Cancel/ESC/outside-click → 'cancelled' via the dialog's
			// internal `completedRef` witness). Our `settle` clears `pending`
			// which unmounts this host (and the dialog under it). So
			// `onOpenChange` is effectively a no-op here — Radix's internal
			// state is fine because the React unmount takes the dialog out
			// of the tree entirely.
			onOpenChange={() => {
				/* close is driven by onComplete → settle → unmount */
			}}
			presetPrompt={pending.args.initialPrompt}
			defaultMode={pending.args.sessionKind ?? 'chat'}
			presetEngineId={pending.args.engineId}
			presetCwd={pending.args.cwd}
			onComplete={handleComplete}
		/>
	);
}
