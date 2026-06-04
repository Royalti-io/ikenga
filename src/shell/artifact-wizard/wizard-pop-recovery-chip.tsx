// "Wrong file?" recovery chip for wizard fallback fires.
//
// Mounted once at workspace root. When the wizard's watcher fires via the
// fallback grace (not slug-match), `scaffold.ts` posts a record to
// `useWizardPopStore` keyed by the studio pane id. This chip renders a
// small floating banner above the focused pane offering:
//   - "Open folder" → swap the loupe back to the grid on the watched
//     folder, so the user can pick the actual artifact.
//   - dismiss X → silence the chip without changing anything.
//
// Auto-dismisses after CHIP_TTL_MS. The chip only shows when the user is
// looking at the pane the loupe was popped into (no point announcing a
// possibly-wrong file on a pane they're not focused on).

import { useEffect } from 'react';
import { FolderOpen } from 'lucide-react';

import { FloatingToastChip } from '@/components/ui/floating-toast-chip';
import { usePaneStore } from '@/lib/panes/pane-store';
import { useWizardPopStore } from '@/shell/artifact-wizard/pop-recovery-store';

const CHIP_TTL_MS = 12_000;

export function WizardPopRecoveryChip() {
	const focusedId = usePaneStore((s) => s.focusedId);
	const pending = useWizardPopStore((s) => s.pending);
	const dismiss = useWizardPopStore((s) => s.dismiss);
	const record = pending[focusedId];

	// TTL: auto-dismiss the record after CHIP_TTL_MS. Re-runs whenever the
	// active record's postedAt changes (a fresh post resets the clock).
	useEffect(() => {
		if (!record) return;
		const remaining = CHIP_TTL_MS - (Date.now() - record.postedAt);
		if (remaining <= 0) {
			dismiss(record.paneId);
			return;
		}
		const t = setTimeout(() => dismiss(record.paneId), remaining);
		return () => clearTimeout(t);
	}, [record, dismiss]);

	if (!record) return null;

	const fileName = record.artifactPath.replace(/^.+\//, '');
	const folderName = record.folder.replace(/^.+\//, '');

	function openFolder() {
		const ps = usePaneStore.getState();
		ps.replaceActiveViewAndPushHistory(record.paneId, {
			kind: 'artifact-studio',
			path: record.folder,
			density: 'grid',
		});
		dismiss(record.paneId);
	}

	return (
		<FloatingToastChip
			variant="notice"
			anchor="viewport-top"
			label={
				<span className="text-muted-foreground">
					Opened <code className="font-mono text-foreground">{fileName}</code>. Wrong file?
				</span>
			}
			action={{
				label: `Open ${folderName}/`,
				icon: <FolderOpen className="h-3 w-3" />,
				onClick: openFolder,
			}}
			onDismiss={() => dismiss(record.paneId)}
		/>
	);
}
