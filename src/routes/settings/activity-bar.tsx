// Settings → Activity bar
//
// Management UI for the user-pinned activity bar entries: rename / re-icon /
// delete sections, drag-to-reorder pins within a section (and across to a
// different section), unpin individual entries. The activity bar's right-
// click menu is the inline shortcut for the same ops.
//
// Mirrors the projects.tsx layout style: a top-level page with one card per
// section + a section-less group at the bottom + a "New section" affordance.

import { useEffect, useMemo, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { GripVertical, Pin as PinGlyph, Plus, Trash2, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { cn } from '@/components/ui/utils';
import { PinIcon } from '@/shell/pin-icon';
import {
	computeCrossSectionReorderIds,
	computeReorderIds,
	RESERVED_SECTION_IDS,
	slugifySectionId,
	usePinsStore,
	type Pin,
	type Section,
} from '@/lib/shell/pins-store';

export const Route = createFileRoute('/settings/activity-bar')({
	component: ActivityBarSettings,
});

const NO_SECTION = '__none__';

function ActivityBarSettings() {
	const sections = usePinsStore((s) => s.sections);
	const pins = usePinsStore((s) => s.pins);
	const hydrated = usePinsStore((s) => s.hydrated);
	const hydrate = usePinsStore((s) => s.hydrate);

	useEffect(() => {
		void hydrate();
	}, [hydrate]);

	const sortedSections = useMemo(
		() =>
			[...sections].sort(
				(a, b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt)
			),
		[sections]
	);
	const pinsBySection = useMemo(() => {
		const m = new Map<string, Pin[]>();
		const sortedPins = [...pins].sort(
			(a, b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt)
		);
		const sectionLess: Pin[] = [];
		for (const pin of sortedPins) {
			if (pin.sectionId === null) {
				sectionLess.push(pin);
			} else {
				const list = m.get(pin.sectionId) ?? [];
				list.push(pin);
				m.set(pin.sectionId, list);
			}
		}
		return { bySection: m, sectionLess };
	}, [pins]);

	return (
		<div className="mx-auto flex max-w-3xl flex-col gap-6 p-8">
			<header className="flex flex-col gap-1">
				<h1 className="text-2xl font-semibold">Activity bar</h1>
				<p className="text-sm text-muted-foreground">
					Sections group your pinned routes, artifacts, and links in the activity bar. Drag pins
					to reorder within a section or to move them between sections.
				</p>
			</header>

			{!hydrated && <p className="text-sm text-muted-foreground">Loading…</p>}

			{hydrated && (
				<>
					{sortedSections.map((section) => (
						<SectionCard
							key={section.id}
							section={section}
							pins={pinsBySection.bySection.get(section.id) ?? []}
						/>
					))}

					<SectionCard
						key={NO_SECTION}
						section={null}
						pins={pinsBySection.sectionLess}
					/>

					<NewSectionForm existing={sortedSections} />
				</>
			)}
		</div>
	);
}

interface SectionCardProps {
	/** null for the implicit "no section" group. */
	section: Section | null;
	pins: Pin[];
}

function SectionCard({ section, pins }: SectionCardProps) {
	const [editingLabel, setEditingLabel] = useState(false);
	const [draftLabel, setDraftLabel] = useState(section?.label ?? '');
	const [editingIcon, setEditingIcon] = useState(false);
	const [draftIconLucide, setDraftIconLucide] = useState(section?.iconLucide ?? '');
	const [draftIconEmoji, setDraftIconEmoji] = useState(section?.iconEmoji ?? '');
	const [confirmDelete, setConfirmDelete] = useState(false);

	const updateSection = usePinsStore((s) => s.updateSection);
	const removeSection = usePinsStore((s) => s.removeSection);

	useEffect(() => {
		setDraftLabel(section?.label ?? '');
		setDraftIconLucide(section?.iconLucide ?? '');
		setDraftIconEmoji(section?.iconEmoji ?? '');
	}, [section]);

	const isVirtual = section === null;
	const sectionId = isVirtual ? NO_SECTION : section.id;

	async function commitLabel() {
		if (isVirtual) return;
		const trimmed = draftLabel.trim();
		if (!trimmed || trimmed === section.label) {
			setEditingLabel(false);
			setDraftLabel(section.label);
			return;
		}
		try {
			await updateSection({ id: section.id, label: trimmed });
		} catch {
			// Revert on failure; the pins-store already pushed the error.
			setDraftLabel(section.label);
		}
		setEditingLabel(false);
	}

	async function commitIcon() {
		if (isVirtual) return;
		try {
			await updateSection({
				id: section.id,
				iconLucide: draftIconLucide.trim() || null,
				iconEmoji: draftIconEmoji.trim() || null,
			});
		} catch {
			setDraftIconLucide(section.iconLucide ?? '');
			setDraftIconEmoji(section.iconEmoji ?? '');
		}
		setEditingIcon(false);
	}

	async function handleDelete() {
		if (isVirtual) return;
		try {
			await removeSection(section.id);
		} catch {
			// fall through; error surfaces via store
		}
		setConfirmDelete(false);
	}

	return (
		<section
			className="rounded-lg border border-border bg-card"
			data-section-id={sectionId}
			aria-label={isVirtual ? 'No section' : `Section ${section.label}`}
		>
			<div className="flex items-center gap-2 border-b border-border px-4 py-3">
				{!isVirtual && section.iconEmoji ? (
					<span className="text-lg leading-none">{section.iconEmoji}</span>
				) : null}
				{editingLabel && !isVirtual ? (
					<Input
						autoFocus
						value={draftLabel}
						onChange={(e) => setDraftLabel(e.target.value)}
						onBlur={commitLabel}
						onKeyDown={(e) => {
							if (e.key === 'Enter') {
								e.preventDefault();
								void commitLabel();
							} else if (e.key === 'Escape') {
								setDraftLabel(section.label);
								setEditingLabel(false);
							}
						}}
						className="h-7 max-w-xs text-sm"
					/>
				) : (
					<button
						type="button"
						onClick={() => !isVirtual && setEditingLabel(true)}
						disabled={isVirtual}
						className={cn(
							'flex-1 text-left text-sm font-medium',
							!isVirtual && 'hover:underline'
						)}
						title={isVirtual ? undefined : 'Click to rename'}
					>
						{isVirtual ? 'No section' : section.label}
						{!isVirtual && (
							<span className="ml-2 text-[11px] font-normal text-muted-foreground">
								(id: {section.id})
							</span>
						)}
					</button>
				)}
				<span className="text-xs text-muted-foreground">
					{pins.length} {pins.length === 1 ? 'pin' : 'pins'}
				</span>
				{!isVirtual && (
					<>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={() => setEditingIcon((v) => !v)}
						>
							Icon
						</Button>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							className="text-destructive hover:text-destructive"
							onClick={() => setConfirmDelete(true)}
							aria-label={`Delete section ${section.label}`}
						>
							<Trash2 className="h-3.5 w-3.5" />
						</Button>
					</>
				)}
			</div>

			{editingIcon && !isVirtual && (
				<div className="flex items-end gap-3 border-b border-border bg-muted/30 px-4 py-3">
					<label className="flex flex-col gap-1">
						<span className="text-[11px] font-medium text-muted-foreground">
							Icon (lucide)
						</span>
						<Input
							value={draftIconLucide}
							onChange={(e) => setDraftIconLucide(e.target.value)}
							placeholder="banknote"
							className="h-7 w-44 text-sm"
						/>
					</label>
					<label className="flex flex-col gap-1">
						<span className="text-[11px] font-medium text-muted-foreground">Emoji</span>
						<Input
							value={draftIconEmoji}
							onChange={(e) => setDraftIconEmoji(e.target.value)}
							placeholder="💰"
							maxLength={4}
							className="h-7 w-20 text-sm"
						/>
					</label>
					<Button type="button" size="sm" onClick={commitIcon}>
						Save
					</Button>
					<Button
						type="button"
						size="sm"
						variant="ghost"
						onClick={() => {
							setDraftIconLucide(section.iconLucide ?? '');
							setDraftIconEmoji(section.iconEmoji ?? '');
							setEditingIcon(false);
						}}
					>
						Cancel
					</Button>
				</div>
			)}

			<PinList sectionId={isVirtual ? null : section.id} pins={pins} />

			{!isVirtual && confirmDelete && (
				<DeleteConfirmDialog
					section={section}
					pinCount={pins.length}
					onCancel={() => setConfirmDelete(false)}
					onConfirm={handleDelete}
				/>
			)}
		</section>
	);
}

interface PinListProps {
	sectionId: string | null;
	pins: Pin[];
}

interface DragState {
	pinId: string;
	fromSectionId: string | null;
}

function PinList({ sectionId, pins }: PinListProps) {
	const removePin = usePinsStore((s) => s.removePin);
	const reorderPins = usePinsStore((s) => s.reorderPins);
	const [drag, setDrag] = useState<DragState | null>(null);
	const [hoverIdx, setHoverIdx] = useState<number | null>(null);

	const sectionKey = sectionId ?? '';

	if (pins.length === 0) {
		return (
			<EmptyDropZone
				sectionId={sectionId}
				onDropPin={async (pinId, fromSectionId) => {
					if (fromSectionId === sectionId) return;
					await reorderPins([pinId], sectionKey);
				}}
			/>
		);
	}

	async function commitDrop(srcIdx: number, dstIdx: number) {
		const ids = computeReorderIds(pins, srcIdx, dstIdx);
		if (ids.length === 0) return;
		await reorderPins(ids, sectionKey);
	}

	async function commitCrossSectionDrop(pinId: string, dstIdx: number) {
		const ids = computeCrossSectionReorderIds(pins, pinId, dstIdx);
		await reorderPins(ids, sectionKey);
	}

	return (
		<ul
			className="flex flex-col"
			data-section-key={sectionKey}
			onDragLeave={(e) => {
				if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
				setHoverIdx(null);
			}}
		>
			{pins.map((pin, idx) => {
				const isDragging = drag?.pinId === pin.id;
				const showInsertBefore = hoverIdx === idx && drag !== null && !isDragging;
				return (
					<li
						key={pin.id}
						draggable
						onDragStart={(e) => {
							e.dataTransfer.effectAllowed = 'move';
							e.dataTransfer.setData(
								'application/x-pin-drag',
								`${pin.id}|${pin.sectionId ?? ''}`
							);
							setDrag({ pinId: pin.id, fromSectionId: pin.sectionId });
						}}
						onDragEnd={() => {
							setDrag(null);
							setHoverIdx(null);
						}}
						onDragOver={(e) => {
							if (!drag) return;
							e.preventDefault();
							e.dataTransfer.dropEffect = 'move';
							const rect = e.currentTarget.getBoundingClientRect();
							const isAbove = e.clientY < rect.top + rect.height / 2;
							const next = isAbove ? idx : idx + 1;
							setHoverIdx((prev) => (prev === next ? prev : next));
						}}
						onDrop={async (e) => {
							e.preventDefault();
							if (!drag) return;
							const rect = e.currentTarget.getBoundingClientRect();
							const isAbove = e.clientY < rect.top + rect.height / 2;
							const dstIdx = isAbove ? idx : idx + 1;
							const wasDragging = drag;
							setDrag(null);
							setHoverIdx(null);
							if (wasDragging.fromSectionId === sectionId) {
								const srcIdx = pins.findIndex((p) => p.id === wasDragging.pinId);
								if (srcIdx < 0) return;
								// Same-position no-op (drop adjacent to self with no movement).
								if (srcIdx === dstIdx || srcIdx + 1 === dstIdx) return;
								await commitDrop(srcIdx, dstIdx);
							} else {
								await commitCrossSectionDrop(wasDragging.pinId, dstIdx);
							}
						}}
						className={cn(
							'group relative flex items-center gap-3 px-4 py-2 transition-colors',
							idx > 0 && 'border-t border-border/40',
							isDragging && 'opacity-40',
							showInsertBefore &&
								'before:absolute before:left-0 before:right-0 before:top-0 before:h-0.5 before:bg-primary'
						)}
					>
						<GripVertical
							className="h-4 w-4 cursor-grab text-muted-foreground/60"
							aria-hidden
						/>
						<div className="grid h-7 w-7 shrink-0 place-items-center rounded bg-muted text-muted-foreground">
							<PinIcon
								iconLucide={pin.iconLucide}
								iconEmoji={pin.iconEmoji}
								Fallback={PinGlyph}
							/>
						</div>
						<div className="flex flex-1 flex-col">
							<span className="truncate text-sm">{pin.label}</span>
							<span className="truncate text-[11px] text-muted-foreground">
								{describePinTarget(pin)}
							</span>
						</div>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={() => removePin(pin.id)}
							aria-label={`Unpin ${pin.label}`}
							className="opacity-0 group-hover:opacity-100"
						>
							<X className="h-3.5 w-3.5" />
						</Button>
					</li>
				);
			})}
			{/* Tail drop target — only shown while dragging so it doesn't take up
			    extra space at rest. Hover state is the implicit pseudo `idx ===
			    pins.length`. */}
			{drag !== null && (
				<li
					data-tail-drop
					onDragOver={(e) => {
						e.preventDefault();
						e.dataTransfer.dropEffect = 'move';
						setHoverIdx(pins.length);
					}}
					onDrop={async (e) => {
						e.preventDefault();
						if (!drag) return;
						const wasDragging = drag;
						setDrag(null);
						setHoverIdx(null);
						if (wasDragging.fromSectionId === sectionId) {
							const srcIdx = pins.findIndex((p) => p.id === wasDragging.pinId);
							if (srcIdx < 0 || srcIdx === pins.length - 1) return;
							await commitDrop(srcIdx, pins.length);
						} else {
							await commitCrossSectionDrop(wasDragging.pinId, pins.length);
						}
					}}
					className={cn(
						'h-3 transition-colors',
						hoverIdx === pins.length && 'border-t-2 border-primary'
					)}
				/>
			)}
		</ul>
	);
}

interface EmptyDropZoneProps {
	sectionId: string | null;
	onDropPin: (pinId: string, fromSectionId: string | null) => void | Promise<void>;
}

function EmptyDropZone({ sectionId, onDropPin }: EmptyDropZoneProps) {
	const [hover, setHover] = useState(false);
	return (
		<div
			onDragOver={(e) => {
				if (!e.dataTransfer.types.includes('application/x-pin-drag')) return;
				e.preventDefault();
				setHover(true);
			}}
			onDragLeave={() => setHover(false)}
			onDrop={async (e) => {
				const payload = e.dataTransfer.getData('application/x-pin-drag');
				if (!payload) {
					setHover(false);
					return;
				}
				const [pinId, fromSection] = payload.split('|');
				setHover(false);
				if (pinId) {
					await onDropPin(pinId, fromSection ? fromSection : null);
				}
			}}
			className={cn(
				'flex items-center justify-center px-4 py-6 text-xs text-muted-foreground transition-colors',
				hover && 'bg-accent/40 text-accent-foreground'
			)}
			data-empty-drop-zone={sectionId ?? '__none__'}
		>
			{hover ? 'Drop to move pin here' : 'No pins yet — pin an artifact from its address bar.'}
		</div>
	);
}

interface NewSectionFormProps {
	existing: readonly Section[];
}

function NewSectionForm({ existing }: NewSectionFormProps) {
	const [open, setOpen] = useState(false);
	const [label, setLabel] = useState('');
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const createSection = usePinsStore((s) => s.createSection);

	const slug = slugifySectionId(label);
	const collides = useMemo(
		() => Boolean(slug) && existing.some((s) => s.id === slug),
		[slug, existing]
	);
	const isReserved = RESERVED_SECTION_IDS.includes(slug);

	if (!open) {
		return (
			<Button
				type="button"
				variant="ghost"
				className="self-start text-muted-foreground"
				onClick={() => setOpen(true)}
			>
				<Plus className="mr-1 h-4 w-4" />
				New section
			</Button>
		);
	}

	async function submit(e: React.FormEvent) {
		e.preventDefault();
		const trimmed = label.trim();
		if (!trimmed) {
			setError('Label is required.');
			return;
		}
		if (!slug) {
			setError('Label must contain at least one letter or digit.');
			return;
		}
		if (isReserved) {
			setError(`'${slug}' is a reserved id (host-owned).`);
			return;
		}
		if (collides) {
			setError(`Section id '${slug}' already exists.`);
			return;
		}
		setSubmitting(true);
		setError(null);
		try {
			await createSection({ id: slug, label: trimmed });
			setLabel('');
			setOpen(false);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSubmitting(false);
		}
	}

	return (
		<form onSubmit={submit} className="flex flex-col gap-2 rounded-lg border border-dashed border-border p-4">
			<label className="flex flex-col gap-1">
				<span className="text-xs font-medium text-muted-foreground">New section label</span>
				<Input
					autoFocus
					value={label}
					onChange={(e) => {
						setLabel(e.target.value);
						if (error) setError(null);
					}}
					placeholder="e.g. Finance"
				/>
				{slug && (
					<span className="text-[11px] text-muted-foreground">
						id: <code className="font-mono">{slug}</code>
						{collides && <span className="ml-2 text-destructive">already exists</span>}
						{isReserved && <span className="ml-2 text-destructive">reserved id</span>}
					</span>
				)}
			</label>
			{error && (
				<div className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
					{error}
				</div>
			)}
			<div className="flex gap-2">
				<Button type="submit" size="sm" disabled={submitting}>
					{submitting ? 'Creating…' : 'Create section'}
				</Button>
				<Button
					type="button"
					size="sm"
					variant="ghost"
					onClick={() => {
						setLabel('');
						setError(null);
						setOpen(false);
					}}
				>
					Cancel
				</Button>
			</div>
		</form>
	);
}

interface DeleteConfirmDialogProps {
	section: Section;
	pinCount: number;
	onCancel: () => void;
	onConfirm: () => void;
}

function DeleteConfirmDialog({
	section,
	pinCount,
	onCancel,
	onConfirm,
}: DeleteConfirmDialogProps) {
	return (
		<Dialog open onOpenChange={(o) => !o && onCancel()}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Delete section "{section.label}"?</DialogTitle>
					<DialogDescription>
						{pinCount === 0 ? (
							<>This section has no pins. It will be removed.</>
						) : (
							<>
								Its {pinCount} {pinCount === 1 ? 'pin' : 'pins'} will move to{' '}
								<strong>No section</strong> — they won't be deleted.
							</>
						)}
					</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<Button type="button" variant="ghost" onClick={onCancel}>
						Cancel
					</Button>
					<Button
						type="button"
						className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
						onClick={onConfirm}
					>
						Delete section
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/** Short subtitle showing the pin's target. Truncates long paths and URLs
 *  for readability. */
function describePinTarget(pin: Pin): string {
	const max = 64;
	const target = pin.target;
	if (target.length <= max) return target;
	return `…${target.slice(-(max - 1))}`;
}
