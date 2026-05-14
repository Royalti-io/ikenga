import { ExternalLink } from 'lucide-react';
import { usePaneStore } from '@/lib/panes/pane-store';
import { cn } from '@/components/ui/utils';

interface ArtifactPillProps {
	path: string;
	mime: string;
	producedBy?: string;
}

function basename(p: string): string {
	return p.split('/').filter(Boolean).pop() ?? p;
}

export function ArtifactPill({ path, mime, producedBy }: ArtifactPillProps) {
	const focusedId = usePaneStore((s) => s.focusedId);
	const addTab = usePaneStore((s) => s.addTab);

	function handleOpen() {
		addTab(focusedId, { kind: 'artifact', path });
	}

	return (
		<button
			type="button"
			onClick={handleOpen}
			className={cn(
				'group inline-flex max-w-full items-center gap-2 rounded-sm border border-[var(--rule)] bg-transparent px-2.5 py-1 text-left',
				'transition-colors hover:border-[var(--kola-amber)] hover:bg-[var(--rule-soft)]'
			)}
			title={path}
		>
			<span aria-hidden className="shrink-0 text-[8px] leading-none text-[var(--kola-amber)]">
				◾
			</span>
			<span className="truncate font-mono text-[11px] text-foreground">{basename(path)}</span>
			<span className="shrink-0 text-[10px] uppercase tracking-wider text-[var(--chip-carve)]">
				{mime}
			</span>
			{producedBy && (
				<span className="shrink-0 text-[10px] uppercase tracking-wider text-[var(--chip-carve)]">
					via {producedBy}
				</span>
			)}
			<ExternalLink className="h-3 w-3 shrink-0 text-[var(--chip-carve)] opacity-0 group-hover:opacity-100" />
		</button>
	);
}
