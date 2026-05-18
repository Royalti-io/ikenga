// Pin-an-artifact dialog. Triggered from the artifact pane's address bar
// (the lucide Pin glyph). Reads the artifact's manifest from disk via
// `readManifestPreview` so label/icon/section default to whatever the
// author suggested, then routes through the pins-store to insert into
// the activity bar — creating a new section first if the user typed
// a name that doesn't fuzzy-match an existing one.

import { useEffect, useMemo, useState } from 'react';
import { Pin as PinGlyph } from 'lucide-react';
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/components/ui/utils';
import {
	fuzzyMatchSection,
	slugifySectionId,
	usePinsStore,
	type Section,
} from '@/lib/shell/pins-store';
import {
	readManifestPreview,
	type ArtifactManifestPreview,
} from '@/lib/artifact/manifest-from-file';

interface PinArtifactDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Filesystem path of the artifact being pinned. */
	path: string;
	/** Optional callback invoked after a successful pin. Receives the new
	 *  pin's id. The dialog closes itself either way. */
	onPinned?: (pinId: string) => void;
}

interface FormState {
	label: string;
	sectionInput: string;
	iconLucide: string;
	iconEmoji: string;
	manifestId: string;
}

const EMPTY_FORM: FormState = {
	label: '',
	sectionInput: '',
	iconLucide: '',
	iconEmoji: '',
	manifestId: '',
};

/** Filename minus directory + extension. Used as the label fallback when
 *  the manifest doesn't have a `name` field. */
function fileBasename(path: string): string {
	const last = path.split(/[/\\]/).pop() ?? path;
	const dot = last.lastIndexOf('.');
	return dot > 0 ? last.slice(0, dot) : last;
}

function defaultsFromManifest(path: string, manifest: ArtifactManifestPreview | null): FormState {
	const m = manifest ?? {};
	return {
		label: m.name ?? fileBasename(path),
		sectionInput: m.pin?.section ?? '',
		iconLucide: m.icon?.lucide ?? m.pin?.icon ?? '',
		iconEmoji: m.icon?.emoji ?? '',
		manifestId: m.id ?? '',
	};
}

export function PinArtifactDialog({ open, onOpenChange, path, onPinned }: PinArtifactDialogProps) {
	const sections = usePinsStore((s) => s.sections);
	const addPin = usePinsStore((s) => s.addPin);
	const createSection = usePinsStore((s) => s.createSection);

	const [form, setForm] = useState<FormState>(EMPTY_FORM);
	const [loading, setLoading] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// (Re)load defaults whenever the dialog opens. Closing the dialog leaves
	// the prior form in place so a user reopening on the same artifact sees
	// what they had — but submitting clears it.
	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		setLoading(true);
		setError(null);
		(async () => {
			const manifest = await readManifestPreview(path);
			if (cancelled) return;
			setForm(defaultsFromManifest(path, manifest));
			setLoading(false);
		})();
		return () => {
			cancelled = true;
		};
	}, [open, path]);

	const matchedSection = useMemo<Section | null>(() => {
		const trimmed = form.sectionInput.trim();
		if (!trimmed) return null;
		// Exact id hit takes precedence so a "finance" id with a "Finance &
		// Treasury" label still resolves cleanly when the user types either.
		const slug = slugifySectionId(trimmed);
		const exact = sections.find(
			(s) => s.id === slug || s.label.toLowerCase() === trimmed.toLowerCase()
		);
		if (exact) return exact;
		return fuzzyMatchSection(trimmed, sections);
	}, [form.sectionInput, sections]);

	const filteredSections = useMemo<Section[]>(() => {
		const q = form.sectionInput.trim().toLowerCase();
		if (!q) return sections.slice(0, 6);
		return sections
			.filter((s) => s.label.toLowerCase().includes(q) || s.id.includes(slugifySectionId(q)))
			.slice(0, 6);
	}, [form.sectionInput, sections]);

	const trimmedSection = form.sectionInput.trim();
	// "Creating" = user typed a non-empty name that doesn't match anything
	// (exact OR fuzzy). When non-empty + matched, we'll just pin into the
	// matched section — same key, no surprise create.
	const willCreateSection = trimmedSection.length > 0 && !matchedSection;
	const newSectionSlug = willCreateSection ? slugifySectionId(trimmedSection) : '';
	const newSectionInvalid = willCreateSection && !newSectionSlug;

	function update<K extends keyof FormState>(key: K, value: FormState[K]) {
		setForm((prev) => ({ ...prev, [key]: value }));
		if (error) setError(null);
	}

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		if (submitting || loading) return;

		const label = form.label.trim();
		if (!label) {
			setError('Label is required.');
			return;
		}
		if (newSectionInvalid) {
			setError('Section name must contain at least one letter or digit.');
			return;
		}

		setSubmitting(true);
		setError(null);
		try {
			let sectionId: string | null = null;
			if (matchedSection) {
				sectionId = matchedSection.id;
			} else if (willCreateSection) {
				const created = await createSection({
					id: newSectionSlug,
					label: trimmedSection,
				});
				sectionId = created.id;
			}

			const pin = await addPin({
				kind: 'artifact',
				target: path,
				label,
				iconLucide: form.iconLucide.trim() || null,
				iconEmoji: form.iconEmoji.trim() || null,
				sectionId,
				manifestId: form.manifestId.trim() || null,
			});

			onPinned?.(pin.id);
			onOpenChange(false);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSubmitting(false);
		}
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<form onSubmit={handleSubmit}>
					<DialogHeader>
						<DialogTitle className="flex items-center gap-2">
							<PinGlyph className="h-4 w-4" />
							Pin to activity bar
						</DialogTitle>
						<DialogDescription>
							{loading ? 'Reading manifest…' : 'Choose where this artifact lives in the bar.'}
						</DialogDescription>
					</DialogHeader>

					<div className="mt-4 flex flex-col gap-4">
						<Field label="Label">
							<Input
								value={form.label}
								onChange={(e) => update('label', e.target.value)}
								placeholder="Display name"
								required
								autoFocus
							/>
						</Field>

						<Field
							label="Section"
							hint={
								matchedSection
									? `Pin to existing section "${matchedSection.label}"`
									: willCreateSection
										? `Will create section "${trimmedSection}" (id: ${newSectionSlug || '—'})`
										: 'Leave empty to pin without a section.'
							}
						>
							<Input
								value={form.sectionInput}
								onChange={(e) => update('sectionInput', e.target.value)}
								placeholder="e.g. Finance"
								list="pin-existing-sections"
								spellCheck={false}
								autoCorrect="off"
								autoCapitalize="off"
							/>
							{filteredSections.length > 0 && (
								<datalist id="pin-existing-sections">
									{filteredSections.map((s) => (
										<option key={s.id} value={s.label} />
									))}
								</datalist>
							)}
						</Field>

						<div className="flex gap-3">
							<Field label="Icon (lucide)" className="flex-1">
								<Input
									value={form.iconLucide}
									onChange={(e) => update('iconLucide', e.target.value)}
									placeholder="banknote"
									spellCheck={false}
								/>
							</Field>
							<Field label="Emoji" className="w-24">
								<Input
									value={form.iconEmoji}
									onChange={(e) => update('iconEmoji', e.target.value)}
									placeholder="💰"
									maxLength={4}
								/>
							</Field>
						</div>

						{form.manifestId && (
							<div className="text-xs text-muted-foreground">
								Manifest id:{' '}
								<code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
									{form.manifestId}
								</code>
								<span className="ml-1">
									(opens via{' '}
									<code className="font-mono text-[11px]">ikenga://artifact/{form.manifestId}</code>
									)
								</span>
							</div>
						)}

						{error && (
							<div className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
								{error}
							</div>
						)}
					</div>

					<DialogFooter className="mt-6">
						<Button
							type="button"
							variant="ghost"
							onClick={() => onOpenChange(false)}
							disabled={submitting}
						>
							Cancel
						</Button>
						<Button type="submit" disabled={submitting || loading}>
							{submitting ? 'Pinning…' : 'Pin'}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

interface FieldProps {
	label: string;
	hint?: string;
	className?: string;
	children: React.ReactNode;
}

function Field({ label, hint, className, children }: FieldProps) {
	return (
		<label className={cn('flex flex-col gap-1', className)}>
			<span className="text-xs font-medium text-muted-foreground">{label}</span>
			{children}
			{hint && <span className="text-[11px] text-muted-foreground/80">{hint}</span>}
		</label>
	);
}
