// Browser-style URL bar shown above pane content for path-bearing views
// (route, artifact). Chat/terminal panes render no address bar — they
// don't have a natural address.
//
// Layout:  [← back] [→ forward] [↻ refresh] [editable URL input]
//
// `replace(view)` swaps the leaf's active view in place and pushes a
// history entry. `bumpKey()` re-mounts the leaf so refresh resets viewer
// state. Invalid input rings the input red briefly without navigating.

import { ArrowLeft, ArrowRight, Pin as PinGlyph, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@/components/ui/utils';
import { Input } from '@/components/ui/input';
import { getPaneAddress, parsePaneAddress } from '@/lib/panes/pane-address';
import { resolveArtifactAddress } from '@/lib/panes/pane-address-resolver';
import type { PaneId, PaneView } from '@/lib/panes/types';
import { usePaneHistory } from '@/lib/panes/use-pane-history';
import { usePinsStore } from '@/lib/shell/pins-store';
import { PinArtifactDialog } from './pin-artifact-dialog';

interface PaneAddressBarProps {
	paneId: PaneId;
	view: PaneView;
}

const INVALID_FLASH_MS = 600;

export function PaneAddressBar({ paneId, view }: PaneAddressBarProps) {
	const { canGoBack, canGoForward, back, forward, replace, bumpKey } = usePaneHistory(paneId, view);

	const address = getPaneAddress(view) ?? '';
	const [draft, setDraft] = useState(address);
	const [invalid, setInvalid] = useState(false);
	const inputRef = useRef<HTMLInputElement | null>(null);

	// External navigations (sidebar click, command palette, back/forward)
	// should sync into the input. We only adopt the upstream value when the
	// user isn't actively editing — checked by focus.
	useEffect(() => {
		if (document.activeElement !== inputRef.current) {
			setDraft(address);
		}
	}, [address]);

	const flashInvalid = useCallback(() => {
		setInvalid(true);
		window.setTimeout(() => setInvalid(false), INVALID_FLASH_MS);
	}, []);

	const submit = useCallback(async () => {
		const parsed = parsePaneAddress(draft);
		if (!parsed) {
			flashInvalid();
			return;
		}
		// `ikenga://artifact/<id>` keeps the literal URI in `path` after
		// parsing — resolve to the on-disk path before navigating. Other
		// address shapes pass through unchanged.
		const { view: resolved, resolved: needed } = await resolveArtifactAddress(parsed);
		if (!resolved) {
			// Resolver only returns null when it actually tried (an `ikenga://`
			// id with no matching pin). Treat that the same as a parse fail.
			if (needed) flashInvalid();
			return;
		}
		// No-op if it matches the current address exactly (avoid cluttering
		// history when the user just hits Enter on what's already loaded).
		if (getPaneAddress(resolved) === address) {
			bumpKey();
			return;
		}
		replace(resolved);
	}, [draft, address, replace, bumpKey, flashInvalid]);

	// Pin button is artifact-only and lights up amber when this exact path
	// is already pinned (so the user knows clicking again would be a dup).
	// Future: clicking when already pinned could open an edit dialog;
	// today it's hidden entirely to avoid suggesting a dup-create.
	const pinForCurrentPath = usePinsStore((s) =>
		view.kind === 'artifact' ? s.pins.find((p) => p.target === view.path) ?? null : null
	);
	const [pinDialogOpen, setPinDialogOpen] = useState(false);

	return (
		<div className="flex shrink-0 items-center gap-0.5 border-b border-border bg-background px-1.5 py-1">
			<NavButton onClick={() => back()} disabled={!canGoBack} title="Back" aria-label="Back">
				<ArrowLeft className="h-3.5 w-3.5" />
			</NavButton>
			<NavButton
				onClick={() => forward()}
				disabled={!canGoForward}
				title="Forward"
				aria-label="Forward"
			>
				<ArrowRight className="h-3.5 w-3.5" />
			</NavButton>
			<NavButton onClick={() => bumpKey()} title="Refresh" aria-label="Refresh pane">
				<RefreshCw className="h-3.5 w-3.5" />
			</NavButton>
			<Input
				ref={inputRef}
				type="text"
				value={draft}
				onChange={(e) => {
					setDraft(e.target.value);
					if (invalid) setInvalid(false);
				}}
				onKeyDown={(e) => {
					if (e.key === 'Enter') {
						e.preventDefault();
						submit();
					} else if (e.key === 'Escape') {
						setDraft(address);
						inputRef.current?.blur();
					}
				}}
				spellCheck={false}
				autoCorrect="off"
				autoCapitalize="off"
				aria-invalid={invalid || undefined}
				aria-label="Address"
				className={cn(
					'ml-1 h-6 flex-1 rounded-sm px-2 py-0 font-mono text-xs',
					invalid && 'border-destructive ring-2 ring-destructive/40'
				)}
			/>
			{view.kind === 'artifact' && (
				<>
					<NavButton
						onClick={() => setPinDialogOpen(true)}
						disabled={pinForCurrentPath !== null}
						title={
							pinForCurrentPath
								? `Already pinned as "${pinForCurrentPath.label}"`
								: 'Pin to activity bar'
						}
						aria-label="Pin to activity bar"
					>
						<PinGlyph
							className={cn(
								'h-3.5 w-3.5',
								pinForCurrentPath && 'fill-current text-amber-500'
							)}
						/>
					</NavButton>
					<PinArtifactDialog
						open={pinDialogOpen}
						onOpenChange={setPinDialogOpen}
						path={view.path}
					/>
				</>
			)}
		</div>
	);
}

interface NavButtonProps {
	onClick: () => void;
	disabled?: boolean;
	title: string;
	'aria-label': string;
	children: React.ReactNode;
}

function NavButton({ onClick, disabled, title, children, ...rest }: NavButtonProps) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			title={title}
			aria-label={rest['aria-label']}
			className={cn(
				'flex h-6 w-6 items-center justify-center rounded',
				'text-muted-foreground transition-colors',
				'hover:bg-accent hover:text-accent-foreground',
				'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent'
			)}
		>
			{children}
		</button>
	);
}
