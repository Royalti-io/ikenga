// Form-based editor for the artifact manifest.
//
// The form maps directly onto the Zod schema in
// `@ikenga/contract/artifact`. Common scalar fields get dedicated inputs;
// nested unions (`dataSources`, `fallback`, `capabilities`, `requires`)
// drop down to a raw-JSON sub-editor in v0 — those shapes are complex
// enough that a discriminated-union form is its own project. Future:
// generate the nested forms from the Zod schema once we know what's
// actually painful in practice.
//
// `onChange` fires for every keystroke. The parent (`studio-pane.tsx`)
// re-serialises the manifest into the HTML source and updates state; we
// don't write directly to disk here. Live Zod validation surfaces a
// banner at the top — invalid drafts still propagate so the user can
// keep typing.

import { useCallback, useMemo, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { ArtifactManifestSchema, type ArtifactManifest } from '@ikenga/contract/artifact';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/components/ui/utils';

interface StudioManifestEditorProps {
	manifest: ArtifactManifest | null;
	onChange: (next: ArtifactManifest) => void;
}

export function StudioManifestEditor({ manifest, onChange }: StudioManifestEditorProps) {
	// Hooks are unconditional — the empty-state render path branches *after*
	// hooks settle so React's call order stays stable across re-renders.
	const validation = useMemo(
		() => (manifest ? ArtifactManifestSchema.safeParse(manifest) : null),
		[manifest]
	);

	const update = useCallback(
		(patch: Partial<ArtifactManifest>) => {
			if (!manifest) return;
			onChange({ ...manifest, ...patch });
		},
		[manifest, onChange]
	);

	const updatePin = useCallback(
		(patch: Partial<NonNullable<ArtifactManifest['pin']>>) => {
			if (!manifest) return;
			const next = { ...(manifest.pin ?? { suggested: false }), ...patch };
			onChange({ ...manifest, pin: next });
		},
		[manifest, onChange]
	);

	const updateNotes = useCallback(
		(patch: Partial<NonNullable<ArtifactManifest['notes']>>) => {
			if (!manifest) return;
			const next = { ...(manifest.notes ?? { enabled: true }), ...patch };
			onChange({ ...manifest, notes: next });
		},
		[manifest, onChange]
	);

	if (!manifest || !validation) {
		return (
			<div className="flex h-full w-full items-center justify-center p-4 text-xs text-muted-foreground">
				No manifest detected. Add a <code className="font-mono">&lt;script&gt;</code> tag with{' '}
				<code className="font-mono">id="ikenga-manifest"</code> to enable the form.
			</div>
		);
	}

	return (
		<div className="flex h-full w-full flex-col overflow-hidden">
			{!validation.success && (
				<ValidationBanner
					errors={validation.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)}
				/>
			)}
			<div className="flex-1 overflow-y-auto p-3 text-xs">
				<Section title="Identity">
					<Field label="id" hint="kebab-case, stable across renames">
						<Input
							value={manifest.id ?? ''}
							onChange={(e) => update({ id: e.target.value })}
							className="h-7 text-xs"
						/>
					</Field>
					<Field label="name">
						<Input
							value={manifest.name ?? ''}
							onChange={(e) => update({ name: e.target.value })}
							className="h-7 text-xs"
						/>
					</Field>
					<Field label="version">
						<Input
							value={manifest.version ?? ''}
							onChange={(e) => update({ version: e.target.value })}
							className="h-7 text-xs"
						/>
					</Field>
					<Field label="description">
						<Textarea
							value={manifest.description ?? ''}
							onChange={(e) => update({ description: e.target.value })}
							className="min-h-[3rem] text-xs"
						/>
					</Field>
					<Field label="author">
						<Input
							value={manifest.author ?? ''}
							onChange={(e) => update({ author: e.target.value })}
							className="h-7 text-xs"
						/>
					</Field>
					<Field label="license">
						<Input
							value={manifest.license ?? ''}
							onChange={(e) => update({ license: e.target.value })}
							className="h-7 text-xs"
						/>
					</Field>
					<Field label="icon (lucide name)">
						<Input
							value={manifest.icon?.lucide ?? ''}
							onChange={(e) => update({ icon: { lucide: e.target.value || undefined } })}
							className="h-7 text-xs"
							placeholder="e.g. bar-chart-2"
						/>
					</Field>
				</Section>

				<Section title="Pin">
					<Field label="suggested" inline>
						<Switch
							checked={manifest.pin?.suggested ?? false}
							onCheckedChange={(v) => updatePin({ suggested: v })}
						/>
					</Field>
					<Field label="section" hint="free-form; host fuzzy-matches at pin time">
						<Input
							value={manifest.pin?.section ?? ''}
							onChange={(e) => updatePin({ section: e.target.value || undefined })}
							className="h-7 text-xs"
						/>
					</Field>
					<Field label="label">
						<Input
							value={manifest.pin?.label ?? ''}
							onChange={(e) => updatePin({ label: e.target.value || undefined })}
							className="h-7 text-xs"
						/>
					</Field>
					<Field label="pin icon (lucide)">
						<Input
							value={manifest.pin?.icon?.lucide ?? ''}
							onChange={(e) => updatePin({ icon: { lucide: e.target.value || undefined } })}
							className="h-7 text-xs"
						/>
					</Field>
				</Section>

				<Section title="Notes">
					<Field label="enabled" inline>
						<Switch
							checked={manifest.notes?.enabled ?? true}
							onCheckedChange={(v) => updateNotes({ enabled: v })}
						/>
					</Field>
				</Section>

				<Section title="Data sources, fallback, capabilities, requires" hint="JSON sub-editor">
					<RawJsonEditor
						value={{
							dataSources: manifest.dataSources,
							fallback: manifest.fallback,
							capabilities: manifest.capabilities,
							requires: manifest.requires,
						}}
						onValid={(parsed) => onChange({ ...manifest, ...parsed })}
					/>
				</Section>
			</div>
		</div>
	);
}

interface SectionProps {
	title: string;
	hint?: string;
	children: React.ReactNode;
}

function Section({ title, hint, children }: SectionProps) {
	return (
		<div className="mb-4 border-b border-border pb-3 last:border-0">
			<div className="mb-2 flex items-baseline gap-2">
				<h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
					{title}
				</h3>
				{hint && <span className="text-[10px] text-muted-foreground/60">{hint}</span>}
			</div>
			<div className="space-y-2">{children}</div>
		</div>
	);
}

interface FieldProps {
	label: string;
	hint?: string;
	inline?: boolean;
	children: React.ReactNode;
}

function Field({ label, hint, inline, children }: FieldProps) {
	return (
		<div
			className={cn('flex gap-2', inline ? 'flex-row items-center justify-between' : 'flex-col')}
		>
			<div className="flex flex-col gap-0.5">
				<span className="font-mono text-[10px] text-muted-foreground">{label}</span>
				{hint && <span className="text-[9px] text-muted-foreground/60">{hint}</span>}
			</div>
			<div className={inline ? 'shrink-0' : 'w-full'}>{children}</div>
		</div>
	);
}

interface ValidationBannerProps {
	errors: string[];
}

function ValidationBanner({ errors }: ValidationBannerProps) {
	return (
		<div className="flex items-start gap-2 border-b border-destructive/40 bg-destructive/10 px-3 py-2 text-[10px] text-destructive">
			<AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
			<div className="flex flex-col gap-0.5">
				{errors.slice(0, 4).map((err) => (
					<span key={err} className="font-mono">
						{err}
					</span>
				))}
				{errors.length > 4 && <span className="opacity-70">… and {errors.length - 4} more</span>}
			</div>
		</div>
	);
}

interface RawJsonEditorProps<T> {
	value: T;
	onValid: (parsed: T) => void;
}

function RawJsonEditor<T>({ value, onValid }: RawJsonEditorProps<T>) {
	// Local-only draft so the user can leave it in a half-typed state without
	// the parent re-serialising every keystroke as broken JSON. We only push
	// up when JSON.parse succeeds.
	const [draft, setDraft] = useState(() => JSON.stringify(value, null, 2));
	const [error, setError] = useState<string | null>(null);

	const onBlur = useCallback(() => {
		try {
			const parsed = JSON.parse(draft);
			setError(null);
			onValid(parsed as T);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, [draft, onValid]);

	return (
		<div className="flex flex-col gap-1">
			<Textarea
				value={draft}
				onChange={(e) => setDraft(e.target.value)}
				onBlur={onBlur}
				spellCheck={false}
				className="min-h-[10rem] font-mono text-[10px] leading-tight"
			/>
			{error && <span className="text-[10px] text-destructive">JSON error: {error}</span>}
		</div>
	);
}
