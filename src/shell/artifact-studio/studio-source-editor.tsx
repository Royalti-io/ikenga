// Monaco-backed source editor for the Studio's source pane.
//
// Artifacts are HTML documents with embedded JSX (in <script type="text/babel">),
// CSS, and JSON. Monaco's `html` language handles the outer document fine and
// recognises the embedded blocks via its built-in tokenizer. We don't enable
// the heavy `typescript` worker — JSX in artifact docs is intentionally simple,
// and Monaco's html mode already gives syntax highlighting + bracket-matching
// in <script> bodies. If we ever need true JSX IntelliSense, swap to TS mode
// inside the script block — but for v0 that's overkill.
//
// The wrapper is intentionally thin: parent owns `value` + `onChange`, dirty
// tracking, and persistence. We just render the editor and forward edits.

import Editor, { type OnMount } from '@monaco-editor/react';
import { useCallback, useRef } from 'react';

interface StudioSourceEditorProps {
	value: string;
	onChange: (next: string) => void;
	/** Read-only while the engine is mid-edit, prevents racing with auto-saves. */
	readOnly?: boolean;
}

export function StudioSourceEditor({ value, onChange, readOnly }: StudioSourceEditorProps) {
	const editorRef = useRef<Parameters<OnMount>[0] | null>(null);

	const handleMount = useCallback<OnMount>((editor) => {
		editorRef.current = editor;
	}, []);

	const handleChange = useCallback(
		(next: string | undefined) => {
			if (next === undefined) return;
			onChange(next);
		},
		[onChange],
	);

	return (
		<div className="h-full w-full">
			<Editor
				height="100%"
				language="html"
				theme="vs-dark"
				value={value}
				onChange={handleChange}
				onMount={handleMount}
				options={{
					readOnly,
					automaticLayout: true,
					minimap: { enabled: false },
					fontSize: 12,
					lineNumbers: 'on',
					scrollBeyondLastLine: false,
					tabSize: 2,
					wordWrap: 'off',
					renderWhitespace: 'selection',
					// JSX inside <script type="text/babel"> is rendered as HTML-embedded
					// JS; the html mode's default tokenisation is good enough for v0.
					formatOnPaste: false,
					formatOnType: false,
				}}
			/>
		</div>
	);
}
