import { useEffect, useState } from 'react';
import { AlertCircle, Loader2 } from 'lucide-react';
import { Markdown } from '@/components/markdown';
import { fsRead } from '@/lib/tauri-cmd';

interface MarkdownViewProps {
	path: string;
}

export function MarkdownView({ path }: MarkdownViewProps) {
	const [state, setState] = useState<
		{ kind: 'loading' } | { kind: 'ready'; body: string } | { kind: 'error'; message: string }
	>({ kind: 'loading' });

	useEffect(() => {
		let cancelled = false;
		setState({ kind: 'loading' });
		fsRead(path)
			.then((res) => {
				if (cancelled) return;
				const body = new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(res.bytes));
				setState({ kind: 'ready', body });
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
	return (
		<div className="h-full overflow-auto">
			<div className="mx-auto w-full max-w-[72ch] px-8 py-8">
				<Markdown content={state.body} cwd={cwd} allowHtml />
			</div>
		</div>
	);
}
