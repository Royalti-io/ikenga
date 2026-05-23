import { useCallback, useEffect, useRef, useState } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { AlertCircle, Eye, Loader2, Pencil, Save } from 'lucide-react';
import { CodeEditor } from '@ikenga/ui-lib';
import { Markdown } from '@/components/markdown';
import { cn } from '@/components/ui/utils';
import { fsRead, fsWriteText } from '@/lib/tauri-cmd';

interface MarkdownViewProps {
	path: string;
	/** When true, show the Edit toggle + split source/preview editor. Defaults
	 *  to false so thumbnails and read-only embeds are unaffected. */
	editable?: boolean;
}

type LoadState =
	| { kind: 'loading' }
	| { kind: 'ready'; body: string }
	| { kind: 'error'; message: string };

type SaveState = { kind: 'idle' } | { kind: 'saving' } | { kind: 'error'; message: string };

export function MarkdownView({ path, editable = false }: MarkdownViewProps) {
	const [state, setState] = useState<LoadState>({ kind: 'loading' });
	// `body` is the last-known on-disk content; `draft` is the editor buffer.
	// They diverge while editing and re-converge on a successful save.
	const [draft, setDraft] = useState('');
	const [mode, setMode] = useState<'preview' | 'edit'>('preview');
	const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' });

	useEffect(() => {
		let cancelled = false;
		setState({ kind: 'loading' });
		setMode('preview');
		setSaveState({ kind: 'idle' });
		fsRead(path)
			.then((res) => {
				if (cancelled) return;
				const body = new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(res.bytes));
				setState({ kind: 'ready', body });
				setDraft(body);
			})
			.catch((err) => {
				if (cancelled) return;
				setState({
					kind: 'error',
					message: err instanceof Error ? err.message : String(err),
				});
			});
		return () => {
			cancelled = true;
		};
	}, [path]);

	const body = state.kind === 'ready' ? state.body : '';
	const dirty = state.kind === 'ready' && draft !== body;

	const save = useCallback(async () => {
		if (state.kind !== 'ready' || !dirty) return;
		const next = draft;
		setSaveState({ kind: 'saving' });
		try {
			await fsWriteText(path, next);
			setState({ kind: 'ready', body: next });
			setSaveState({ kind: 'idle' });
		} catch (err) {
			setSaveState({
				kind: 'error',
				message: err instanceof Error ? err.message : String(err),
			});
		}
	}, [state.kind, dirty, draft, path]);

	// Keep the latest save handler reachable from the keydown listener without
	// re-binding the listener on every keystroke.
	const saveRef = useRef(save);
	saveRef.current = save;
	useEffect(() => {
		if (mode !== 'edit') return;
		const onKeyDown = (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
				e.preventDefault();
				void saveRef.current();
			}
		};
		window.addEventListener('keydown', onKeyDown);
		return () => window.removeEventListener('keydown', onKeyDown);
	}, [mode]);

	if (state.kind === 'loading') {
		return (
			<div className="flex h-full items-center justify-center text-xs text-muted-foreground">
				<Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
			</div>
		);
	}
	if (state.kind === 'error') {
		return (
			<div className="flex h-full items-start justify-center p-6 text-xs text-destructive">
				<AlertCircle className="mr-2 mt-0.5 h-4 w-4 shrink-0" />
				<span className="break-all">{state.message}</span>
			</div>
		);
	}

	// Resolve relative links inside the doc against the file's directory.
	const cwd = path.replace(/\/[^/]+$/, '');

	// Read-only path — byte-for-byte the prior behavior (no toolbar). Keeps
	// thumbnails and non-editable embeds untouched.
	if (!editable) {
		return (
			<div className="h-full overflow-auto">
				<div className="mx-auto w-full max-w-[72ch] px-8 py-8">
					<Markdown content={body} cwd={cwd} allowHtml />
				</div>
			</div>
		);
	}

	return (
		<div className="flex h-full w-full flex-col">
			<Toolbar
				mode={mode}
				dirty={dirty}
				saveState={saveState}
				onToggle={() => setMode((m) => (m === 'edit' ? 'preview' : 'edit'))}
				onSave={() => void save()}
			/>
			{saveState.kind === 'error' && (
				<div className="flex items-start gap-2 border-b border-destructive/40 bg-destructive/10 px-4 py-1.5 text-[11px] text-destructive">
					<AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
					<span className="break-all">Save failed: {saveState.message}</span>
				</div>
			)}
			<div className="min-h-0 flex-1">
				{mode === 'preview' ? (
					<div className="h-full overflow-auto">
						<div className="mx-auto w-full max-w-[72ch] px-8 py-8">
							<Markdown content={body} cwd={cwd} allowHtml />
						</div>
					</div>
				) : (
					<PanelGroup direction="horizontal" className="h-full w-full">
						<Panel defaultSize={50} minSize={25} className="min-w-0">
							<CodeEditor
								value={draft}
								onChange={setDraft}
								language="markdown"
								ariaLabel="Markdown source"
							/>
						</Panel>
						<PanelResizeHandle className="w-px bg-border transition-colors hover:bg-primary/40 data-[resize-handle-active]:bg-primary/60" />
						<Panel defaultSize={50} minSize={25} className="min-w-0">
							<div className="h-full overflow-auto">
								<div className="mx-auto w-full max-w-[72ch] px-8 py-8">
									<Markdown content={draft} cwd={cwd} allowHtml />
								</div>
							</div>
						</Panel>
					</PanelGroup>
				)}
			</div>
		</div>
	);
}

interface ToolbarProps {
	mode: 'preview' | 'edit';
	dirty: boolean;
	saveState: SaveState;
	onToggle: () => void;
	onSave: () => void;
}

function Toolbar({ mode, dirty, saveState, onToggle, onSave }: ToolbarProps) {
	const editing = mode === 'edit';
	return (
		<div className="flex shrink-0 items-center gap-2 border-b border-border bg-muted/20 px-3 py-1.5 text-xs">
			<button
				type="button"
				onClick={onToggle}
				className="inline-flex items-center gap-1.5 rounded px-2 py-1 font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
			>
				{editing ? <Eye className="h-3.5 w-3.5" /> : <Pencil className="h-3.5 w-3.5" />}
				{editing ? 'Preview' : 'Edit'}
			</button>
			{dirty && (
				<span
					role="status"
					className="h-1.5 w-1.5 rounded-full bg-amber-500"
					title="Unsaved changes"
					aria-label="Unsaved changes"
				/>
			)}
			{editing && (
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
			)}
		</div>
	);
}
