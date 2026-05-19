// CodeMirror 6 backed source editor for the Studio's source pane.
//
// Artifacts are HTML documents with embedded JSX (in <script type="text/babel">),
// CSS, and JSON. The shared `<CodeEditor>` from `@ikenga/ui-lib` ships an HTML
// language mode that tokenises the outer document and the embedded blocks
// well enough for v0. We don't enable LSP — JSX inside artifacts is
// intentionally simple; if true JSX IntelliSense is ever needed, pass an
// `lspClient` per the @ikenga/ui-lib README.
//
// The wrapper is intentionally thin: parent owns `value` + `onChange`, dirty
// tracking, and persistence. We just render the editor and forward edits.

import { CodeEditor } from '@ikenga/ui-lib';

interface StudioSourceEditorProps {
	value: string;
	onChange: (next: string) => void;
	/** Read-only while the engine is mid-edit, prevents racing with auto-saves. */
	readOnly?: boolean;
}

export function StudioSourceEditor({ value, onChange, readOnly }: StudioSourceEditorProps) {
	return (
		<div className="h-full w-full">
			<CodeEditor
				value={value}
				onChange={onChange}
				readOnly={readOnly}
				language="html"
				ariaLabel="Artifact source"
			/>
		</div>
	);
}
