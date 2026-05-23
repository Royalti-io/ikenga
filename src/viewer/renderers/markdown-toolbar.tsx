// Presentational toolbar for the markdown editor. Owns no editor state — the
// parent passes the current mode/dirty/save status and the action callbacks,
// which it implements against the live CodeMirror view.

import {
	Bold,
	Code,
	Eye,
	Heading,
	Italic,
	Link as LinkIcon,
	List,
	Loader2,
	Pencil,
	Quote,
	Save,
	WandSparkles,
} from 'lucide-react';
import { cn } from '@/components/ui/utils';

export type SaveState = { kind: 'idle' } | { kind: 'saving' } | { kind: 'error'; message: string };

interface MarkdownToolbarProps {
	mode: 'preview' | 'edit';
	dirty: boolean;
	saveState: SaveState;
	formatting: boolean;
	onToggle: () => void;
	onSave: () => void;
	onFormatDoc: () => void;
	onWrap: (before: string, after?: string) => void;
	onPrefix: (prefix: string) => void;
	onLink: () => void;
}

export function MarkdownToolbar({
	mode,
	dirty,
	saveState,
	formatting,
	onToggle,
	onSave,
	onFormatDoc,
	onWrap,
	onPrefix,
	onLink,
}: MarkdownToolbarProps) {
	const editing = mode === 'edit';
	return (
		<div className="flex shrink-0 items-center gap-1 border-b border-border bg-muted/20 px-3 py-1.5 text-xs">
			<ToolbarButton onClick={onToggle} label={editing ? 'Preview' : 'Edit'}>
				{editing ? <Eye className="h-3.5 w-3.5" /> : <Pencil className="h-3.5 w-3.5" />}
				{editing ? 'Preview' : 'Edit'}
			</ToolbarButton>

			{editing && (
				<>
					<Divider />
					<IconButton title="Bold (⌘B)" onClick={() => onWrap('**')}>
						<Bold className="h-3.5 w-3.5" />
					</IconButton>
					<IconButton title="Italic (⌘I)" onClick={() => onWrap('_')}>
						<Italic className="h-3.5 w-3.5" />
					</IconButton>
					<IconButton title="Inline code" onClick={() => onWrap('`')}>
						<Code className="h-3.5 w-3.5" />
					</IconButton>
					<IconButton title="Heading" onClick={() => onPrefix('## ')}>
						<Heading className="h-3.5 w-3.5" />
					</IconButton>
					<IconButton title="Bullet list" onClick={() => onPrefix('- ')}>
						<List className="h-3.5 w-3.5" />
					</IconButton>
					<IconButton title="Quote" onClick={() => onPrefix('> ')}>
						<Quote className="h-3.5 w-3.5" />
					</IconButton>
					<IconButton title="Link" onClick={onLink}>
						<LinkIcon className="h-3.5 w-3.5" />
					</IconButton>
					<Divider />
					<IconButton title="Format document" onClick={onFormatDoc} disabled={formatting}>
						{formatting ? (
							<Loader2 className="h-3.5 w-3.5 animate-spin" />
						) : (
							<WandSparkles className="h-3.5 w-3.5" />
						)}
					</IconButton>

					{dirty && (
						<span
							role="status"
							className="ml-1 h-1.5 w-1.5 rounded-full bg-amber-500"
							title="Unsaved changes"
							aria-label="Unsaved changes"
						/>
					)}
					<button
						type="button"
						onClick={onSave}
						disabled={!dirty || saveState.kind === 'saving'}
						className={cn(
							'ml-auto inline-flex items-center gap-1.5 rounded px-2 py-1 font-medium transition-colors',
							dirty && saveState.kind !== 'saving'
								? 'text-foreground hover:bg-muted'
								: 'cursor-not-allowed text-muted-foreground/50'
						)}
					>
						{saveState.kind === 'saving' ? (
							<Loader2 className="h-3.5 w-3.5 animate-spin" />
						) : (
							<Save className="h-3.5 w-3.5" />
						)}
						Save
					</button>
				</>
			)}
		</div>
	);
}

function ToolbarButton({
	onClick,
	label,
	children,
}: {
	onClick: () => void;
	label: string;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-label={label}
			className="inline-flex items-center gap-1.5 rounded px-2 py-1 font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
		>
			{children}
		</button>
	);
}

function IconButton({
	onClick,
	title,
	disabled,
	children,
}: {
	onClick: () => void;
	title: string;
	disabled?: boolean;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			title={title}
			aria-label={title}
			disabled={disabled}
			className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
		>
			{children}
		</button>
	);
}

function Divider() {
	return <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />;
}
