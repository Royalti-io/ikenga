/* approve-gate-panel — the run-then-pause draft-review surface.
 *
 * Renders the locked D-04 approve-gate (plans/atelier/designs/atelier-approve-gate.html) as a
 * shell surface: a resizable master-detail split (draft queue + editor + sticky action footer)
 * over the app-kit component classes + this surface's pattern-glue CSS.
 *
 * SEAM (the renderer is the sibling plans/atelier/ plan — 07-fe-button-renderer.md §3.5): the
 * run-then-pause behavior is injected via the typed props below. `drafts` is the pa-action-paused
 * payload; onApprove fires after the host's 10s undo window (host.paActionsCommit); onReject is
 * pa-action-reject. Until that plumbing lands, the fixture harness/tests stub these props. The
 * 10s countdown is rendered locally here (the shell toast component is not built yet). */

// biome-ignore-all lint/a11y/useSemanticElements: custom ARIA widget porting the locked D-04 a11y spec — rows are div[role=button] (they contain a nested checkbox <button>, so a real <button> would be invalid HTML); the resize handle is role=separator; the queue role=list; the footer role=toolbar; the undo toast role=status. All intentional.

import {
	type CSSProperties,
	type KeyboardEvent as ReactKeyboardEvent,
	type ReactNode,
	type PointerEvent as ReactPointerEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from 'react';
import './approve-gate-panel.css';

// ── Types (mirror 07-fe-button-renderer.md §3.5; the renderer injects these) ──────────────────

export type DraftChannel = 'smtp' | 'resend' | 'listmonk' | 'buffer';

export interface PausedDraft {
	id: string;
	recipient: string;
	recipientEmail: string | null;
	tenantId: string | null;
	subject: string;
	body: string;
	bodyPreview: string;
	channel: DraftChannel;
	agent: string;
	senderAddress: string;
	cold: boolean;
	status: 'awaiting' | 'edited' | 'overdue';
	scheduledAt: string;
	scheduledLabel: string;
	timeVariant: 'is-today' | 'is-overdue' | null;
	overdue: boolean;
	everEdited: boolean;
	section: string;
	sequence: { name: string; step: number; total: number; recipients: number } | null;
	fromProvider: string;
	model: string;
	threadCount: string;
	deal: string | null;
	consequence: {
		target: string;
		recipients: number;
		channel: string;
		time: string;
		undoMs: number;
	};
}

export interface ApproveGatePanelProps {
	drafts: PausedDraft[];
	/** Host fires the side effect after its 10s undo window (host.paActionsCommit). */
	onApprove: (draftId: string) => void;
	/** pa-action-reject — draft discarded. */
	onReject: (draftId: string) => void;
	onSendToChat: (draftId: string) => void;
	onContinueSession: (draftId: string) => void;
	/** Persisted inline edits (⌘S). Optional — the harness logs them. */
	onEdit?: (draftId: string, patch: { subject?: string; body?: string }) => void;
}

const CHANNEL_LABEL: Record<DraftChannel, string> = {
	smtp: 'SMTP',
	resend: 'Resend',
	listmonk: 'Listmonk',
	buffer: 'Buffer',
};

const LIST_W_DEFAULT = 420;
const LIST_W_MIN = 320;
const DETAIL_W_MIN = 480;

// ── Inline icons (faithful to D-04, zero dep) ─────────────────────────────────────────────────

type IconProps = { className?: string };
const svg = (path: ReactNode) => (p: IconProps) => (
	<svg
		className={p.className}
		viewBox="0 0 16 16"
		width="14"
		height="14"
		fill="none"
		stroke="currentColor"
		strokeWidth="1.5"
		strokeLinecap="round"
		strokeLinejoin="round"
		aria-hidden="true"
	>
		{path}
	</svg>
);
const IcoCheck = svg(<path d="M3.5 8.5l3 3 6-7" />);
const IcoX = svg(<path d="M4 4l8 8M12 4l-8 8" />);
const IcoPlus = svg(<path d="M8 3v10M3 8h10" />);
const IcoSort = svg(<path d="M5 3v10M5 13l-2-2M5 3l2 2M11 13V3M11 3l-2 2M11 13l2-2" />);
const IcoBack = svg(<path d="M10 3l-5 5 5 5" />);
const IcoClock = svg(
	<>
		<circle cx="8" cy="8" r="5.5" />
		<path d="M8 5v3l2 1.5" />
	</>
);
const IcoUp = svg(<path d="M4 10l4-4 4 4" />);
const IcoDown = svg(<path d="M4 6l4 4 4-4" />);
const IcoChat = svg(<path d="M3 4h10v7H8l-3 2v-2H3z" />);
const IcoContinue = svg(<path d="M3 5l3 3-3 3M8 5l3 3-3 3" />);
const IcoPencil = svg(<path d="M10.5 3.5l2 2L6 12l-3 .8.8-3z" />);
const IcoSeq = svg(
	<>
		<circle cx="4" cy="4" r="1.5" />
		<circle cx="4" cy="12" r="1.5" />
		<circle cx="12" cy="8" r="1.5" />
		<path d="M4 5.5v5M5.3 4.6L10.7 7M5.3 11.4L10.7 9" />
	</>
);

// ── Component ─────────────────────────────────────────────────────────────────────────────────

export function ApproveGatePanel(props: ApproveGatePanelProps) {
	const { drafts, onApprove, onReject, onSendToChat, onContinueSession, onEdit } = props;

	const [resolved, setResolved] = useState<Set<string>>(() => new Set());
	const visible = useMemo(() => drafts.filter((d) => !resolved.has(d.id)), [drafts, resolved]);

	const [selectedId, setSelectedId] = useState<string | null>(visible[0]?.id ?? null);
	const [checked, setChecked] = useState<Set<string>>(() => new Set());
	const [listWidth, setListWidth] = useState<number | null>(null);
	const [edits, setEdits] = useState<
		Record<string, { subject: string; body: string; everEdited: boolean; savedAt: string | null }>
	>({});
	const [undo, setUndo] = useState<{ draftId: string; secondsLeft: number } | null>(null);

	const splitRef = useRef<HTMLDivElement>(null);
	const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());

	// keep selection valid as rows resolve
	useEffect(() => {
		if (selectedId && !visible.some((d) => d.id === selectedId)) {
			setSelectedId(visible[0]?.id ?? null);
		}
	}, [visible, selectedId]);

	const selected = visible.find((d) => d.id === selectedId) ?? null;

	// display order = sections (Overdue → Today → This week), flattened.
	// J/K navigation and the "N of M" counter follow THIS order, not the prop order.
	const sections = useMemo(() => groupBySection(visible), [visible]);
	const flat = useMemo(() => sections.flatMap(([, rows]) => rows), [sections]);

	// derive the current (possibly edited) subject/body for a draft
	const draftSubject = (d: PausedDraft) => edits[d.id]?.subject ?? d.subject;
	const draftBody = (d: PausedDraft) => edits[d.id]?.body ?? d.body;
	const isEdited = (d: PausedDraft) => d.everEdited || !!edits[d.id]?.everEdited;

	// ── editing ──────────────────────────────────────────────────────────────────────────────
	const patchEdit = useCallback(
		(id: string, patch: { subject?: string; body?: string }, base: PausedDraft) => {
			setEdits((prev) => {
				const cur = prev[id] ?? {
					subject: base.subject,
					body: base.body,
					everEdited: base.everEdited,
					savedAt: null,
				};
				return { ...prev, [id]: { ...cur, ...patch } };
			});
		},
		[]
	);

	// Intentionally NOT memoized: it reads the live `edits` through draftSubject/draftBody, so it
	// must close over the latest render. A [onEdit]-memoized version would persist stale values.
	const save = (d: PausedDraft) => {
		setEdits((prev) => {
			const cur = prev[d.id] ?? {
				subject: d.subject,
				body: d.body,
				everEdited: d.everEdited,
				savedAt: null,
			};
			return { ...prev, [d.id]: { ...cur, everEdited: true, savedAt: nowLabel() } };
		});
		onEdit?.(d.id, { subject: draftSubject(d), body: draftBody(d) });
	};

	// ── approve / reject / handoff ─────────────────────────────────────────────────────────────
	const startApprove = useCallback((d: PausedDraft) => {
		setUndo({ draftId: d.id, secondsLeft: Math.round((d.consequence.undoMs ?? 10000) / 1000) });
	}, []);

	const cancelUndo = useCallback(() => setUndo(null), []);

	// drive the undo countdown; commit (onApprove + hide row) when it hits 0
	useEffect(() => {
		if (!undo) return;
		if (undo.secondsLeft <= 0) {
			onApprove(undo.draftId);
			setResolved((prev) => new Set(prev).add(undo.draftId));
			setUndo(null);
			return;
		}
		const t = setTimeout(
			() => setUndo((u) => (u ? { ...u, secondsLeft: u.secondsLeft - 1 } : null)),
			1000
		);
		return () => clearTimeout(t);
	}, [undo, onApprove]);

	const reject = useCallback(
		(id: string) => {
			onReject(id);
			setResolved((prev) => new Set(prev).add(id));
			setChecked((prev) => {
				const next = new Set(prev);
				next.delete(id);
				return next;
			});
		},
		[onReject]
	);

	// ── selection + bulk ────────────────────────────────────────────────────────────────────────
	const selectRow = useCallback((id: string) => setSelectedId(id), []);
	const toggleCheck = useCallback((id: string) => {
		setChecked((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}, []);
	const clearChecked = useCallback(() => setChecked(new Set()), []);
	const approveAllChecked = useCallback(() => {
		checked.forEach((id) => {
			onApprove(id);
		});
		setResolved((prev) => new Set([...prev, ...checked]));
		setChecked(new Set());
	}, [checked, onApprove]);
	const rejectAllChecked = useCallback(() => {
		checked.forEach((id) => {
			onReject(id);
		});
		setResolved((prev) => new Set([...prev, ...checked]));
		setChecked(new Set());
	}, [checked, onReject]);

	// ── J / K row navigation (blocker 5) ─────────────────────────────────────────────────────────
	const move = useCallback(
		(delta: number) => {
			if (flat.length === 0) return;
			const idx = Math.max(
				0,
				flat.findIndex((d) => d.id === selectedId)
			);
			const next = flat[Math.min(flat.length - 1, Math.max(0, idx + delta))];
			if (next) {
				setSelectedId(next.id);
				rowRefs.current.get(next.id)?.focus();
			}
		},
		[flat, selectedId]
	);

	// ── divider drag-resize ───────────────────────────────────────────────────────────────────────
	const onDividerDown = useCallback((e: ReactPointerEvent) => {
		e.preventDefault();
		const split = splitRef.current;
		if (!split) return;
		split.classList.add('is-resizing');
		const onMove = (ev: PointerEvent) => {
			const rect = split.getBoundingClientRect();
			const raw = ev.clientX - rect.left;
			const max = rect.width - DETAIL_W_MIN - 4;
			setListWidth(Math.max(LIST_W_MIN, Math.min(raw, max)));
		};
		const onUp = () => {
			split.classList.remove('is-resizing');
			window.removeEventListener('pointermove', onMove);
			window.removeEventListener('pointerup', onUp);
		};
		window.addEventListener('pointermove', onMove);
		window.addEventListener('pointerup', onUp);
	}, []);
	const resetDivider = useCallback(() => setListWidth(null), []);
	const onDividerKey = useCallback((e: ReactKeyboardEvent) => {
		if (e.key === 'ArrowLeft')
			setListWidth((w) => Math.max(LIST_W_MIN, (w ?? LIST_W_DEFAULT) - 24));
		else if (e.key === 'ArrowRight') setListWidth((w) => (w ?? LIST_W_DEFAULT) + 24);
	}, []);

	// ── keyboard: ⌘S save · ⌘↵ approve · ⌘K send-to-chat (in the editor) ──────────────────────────
	// Plain function (not memoized): it calls the un-memoized `save`, so it must re-read each render.
	const onDetailKeyDown = (e: ReactKeyboardEvent) => {
		if (!selected) return;
		const meta = e.metaKey || e.ctrlKey;
		if (!meta) return;
		if (e.key === 's') {
			e.preventDefault();
			save(selected);
		} else if (e.key === 'Enter') {
			e.preventDefault();
			startApprove(selected);
		} else if (e.key === 'k') {
			e.preventDefault();
			onSendToChat(selected.id);
		}
	};

	// ── J/K on the surface (only when focus isn't in a text field) ────────────────────────────────
	const onSurfaceKeyDown = useCallback(
		(e: ReactKeyboardEvent) => {
			const tag = (e.target as HTMLElement)?.tagName;
			if (tag === 'INPUT' || tag === 'TEXTAREA') return;
			if (e.key === 'j') {
				e.preventDefault();
				move(1); // Next (j = down, vim convention)
			} else if (e.key === 'k') {
				e.preventDefault();
				move(-1); // Previous (k = up, vim convention)
			}
		},
		[move]
	);

	const selectedIndex = selected ? flat.findIndex((d) => d.id === selected.id) : -1;
	const consequence = selected ? consequenceStrings(selected) : null;

	const splitStyle =
		listWidth != null ? ({ '--list-w': `${listWidth}px` } as CSSProperties) : undefined;

	return (
		<section className="ob-surface" aria-label="Draft approvals" onKeyDown={onSurfaceKeyDown}>
			<div className="ob-split" ref={splitRef} style={splitStyle}>
				{/* ── Left: draft queue ─────────────────────────────────────────────── */}
				<div className="ob-list" role="list" aria-label="Drafts awaiting approval">
					<div className="ob-toolbar">
						<span className="ob-toolbar-title">Approvals</span>
						<span className="ob-toolbar-meta">
							{visible.length} · {visible.filter((d) => d.overdue).length} overdue
						</span>
						<span className="ob-toolbar-spacer" />
						<button type="button" className="btn-icon" aria-label="Sort drafts">
							<IcoSort />
						</button>
						<button type="button" className="btn-icon" aria-label="New draft">
							<IcoPlus />
						</button>
					</div>

					<div className="ob-filters" role="group" aria-label="Filter drafts">
						{['Mine', 'Today', 'Overdue', 'By channel', 'By sequence'].map((f, i) => (
							<button
								type="button"
								key={f}
								className={`ob-filter${i === 0 ? ' is-on' : ''}`}
								aria-pressed={i === 0}
							>
								{f}
							</button>
						))}
					</div>

					{checked.size > 0 && (
						<div className="ob-bulk">
							<span className="ob-bulk-count">{checked.size} selected</span>
							<span className="ob-bulk-spacer" />
							<button
								type="button"
								className="btn btn-sm ob-actions-primary"
								onClick={approveAllChecked}
							>
								Approve all
							</button>
							<button type="button" className="btn btn-sm" onClick={rejectAllChecked}>
								Reject all
							</button>
							<button type="button" className="btn btn-sm btn-ghost" onClick={clearChecked}>
								Clear
							</button>
						</div>
					)}

					{visible.length === 0 ? (
						<div className="atelier-state is-empty" role="status">
							No approvals pending
						</div>
					) : (
						sections.map(([section, rows]) => (
							<div key={section}>
								<div className="ob-section">
									{section}
									<span className="ob-section-count">· {rows.length}</span>
								</div>
								{rows.map((d) => (
									<div
										key={d.id}
										ref={(el) => {
											if (el) rowRefs.current.set(d.id, el);
											else rowRefs.current.delete(d.id);
										}}
										className={`ob-row status-${d.status}${selectedId === d.id ? ' is-selected' : ''}${checked.has(d.id) ? ' is-checked' : ''}`}
										role="button"
										tabIndex={0}
										aria-label={`${d.recipient} – ${draftSubject(d)}`}
										aria-current={selectedId === d.id ? 'true' : undefined}
										onClick={() => selectRow(d.id)}
										onKeyDown={(e) => {
											if (e.key === 'Enter' || e.key === ' ') {
												e.preventDefault();
												selectRow(d.id);
											}
										}}
									>
										<button
											type="button"
											className="ob-row-check"
											role="checkbox"
											aria-checked={checked.has(d.id)}
											aria-label={`Select ${d.recipient} draft`}
											onClick={(e) => {
												e.stopPropagation();
												toggleCheck(d.id);
											}}
										>
											<IcoCheck />
										</button>
										<div className="ob-row-tick" aria-hidden="true" />
										<div>
											<div className="ob-row-meta">
												<span className="ob-row-to">{d.recipient}</span>
												<span className={`ob-row-time${d.timeVariant ? ` ${d.timeVariant}` : ''}`}>
													{d.scheduledAt}
												</span>
											</div>
											<div className="ob-row-subject">{draftSubject(d)}</div>
											<div className="ob-row-preview">{d.bodyPreview}</div>
											<div className="ob-row-chips">
												<span className={`ob-chip channel-${d.channel}`}>
													{CHANNEL_LABEL[d.channel]}
												</span>
												{isEdited(d) && <span className="ob-chip edited">EDITED</span>}
												<span className="ob-chip agent">{d.agent}</span>
												<span className={`ob-chip sender${d.cold ? ' cold' : ''}`}>
													{d.senderAddress}
												</span>
												{d.sequence && (
													<span className="ob-chip seq">
														Step {d.sequence.step}/{d.sequence.total} · {d.sequence.name}
													</span>
												)}
											</div>
										</div>
									</div>
								))}
							</div>
						))
					)}
				</div>

				{/* ── Divider ─────────────────────────────────────────────────────────── */}
				<div
					className="ob-divider"
					role="separator"
					aria-orientation="vertical"
					aria-label="Resize draft list"
					aria-valuenow={Math.round(listWidth ?? LIST_W_DEFAULT)}
					aria-valuemin={LIST_W_MIN}
					tabIndex={0}
					onPointerDown={onDividerDown}
					onDoubleClick={resetDivider}
					onKeyDown={onDividerKey}
				/>

				{/* ── Right: draft editor ─────────────────────────────────────────────── */}
				{/* biome-ignore lint/a11y/noStaticElementInteractions: editor-scoped ⌘S/⌘↵/⌘K shortcuts */}
				<div className="ob-detail" onKeyDown={onDetailKeyDown}>
					{selected ? (
						<>
							<div className="ob-detail-toolbar">
								<button
									type="button"
									className="btn-icon"
									aria-label="Back to list"
									onClick={() => move(-1)}
								>
									<IcoBack />
								</button>
								<button type="button" className="btn-icon" aria-label="Schedule for later">
									<IcoClock />
								</button>
								<button
									type="button"
									className="btn-icon"
									aria-label="Reject draft"
									onClick={() => reject(selected.id)}
								>
									<IcoX />
								</button>
								<span className="ob-detail-toolbar-spacer" />
								<span className="ob-detail-toolbar-meta">
									{selectedIndex + 1} of {visible.length}
								</span>
								<button
									type="button"
									className="btn-icon"
									aria-label="Previous draft (K)"
									aria-keyshortcuts="k"
									onClick={() => move(-1)}
								>
									<IcoUp />
								</button>
								<button
									type="button"
									className="btn-icon"
									aria-label="Next draft (J)"
									aria-keyshortcuts="j"
									onClick={() => move(1)}
								>
									<IcoDown />
								</button>
							</div>

							<div className="ob-detail-body">
								<div className="ob-detail-head">
									<div className="ob-detail-to-row">
										<div className="ob-avatar" aria-hidden="true">
											{initials(selected.recipient)}
										</div>
										<div>
											<div className="ob-detail-to-name">{selected.recipient}</div>
											<div className="ob-detail-to-addr">
												{selected.recipientEmail ?? '—'}
												{selected.tenantId ? ` · Tenant ${selected.tenantId}` : ''}
											</div>
										</div>
										<div className="ob-detail-to-from">
											<div>
												From <span>{selected.senderAddress}</span>
											</div>
											<div>via {selected.fromProvider}</div>
										</div>
									</div>

									<input
										className="ob-edit-subject"
										aria-label="Email subject"
										value={draftSubject(selected)}
										onChange={(e) => patchEdit(selected.id, { subject: e.target.value }, selected)}
									/>

									<div className="ob-detail-meta">
										<span
											className="ob-chip"
											style={{
												color: 'var(--live)',
												borderColor: 'var(--live-soft)',
												background: 'var(--live-soft)',
											}}
										>
											ux_mode · approve
										</span>
										<span className={`ob-chip channel-${selected.channel}`}>
											{CHANNEL_LABEL[selected.channel]}
										</span>
										<span className="ob-chip agent">
											mail · drafted by your Chi · {selected.model}
										</span>
										{selected.deal && (
											<span
												className="ob-chip"
												style={{
													color: 'var(--achievement)',
													borderColor: 'var(--achievement-soft)',
													background: 'var(--achievement-soft)',
												}}
											>
												Active deal · {selected.deal}
											</span>
										)}
										<span className="ob-chip">Thread {selected.threadCount}</span>
										<span
											className="ob-chip"
											style={{
												color: 'var(--tint-fg-active)',
												borderColor: 'color-mix(in srgb, var(--tint-fg-active) 30%, var(--border))',
											}}
										>
											{selected.scheduledLabel}
										</span>
									</div>
								</div>

								{selected.sequence && (
									<div className="ob-seq-callout" role="region" aria-label="Sequence context">
										<IcoSeq />
										<strong>{selected.sequence.name}</strong> — Step {selected.sequence.step} of{' '}
										{selected.sequence.total} · {selected.sequence.recipients} recipients
										<div className="ob-seq-callout-actions">
											<button type="button" className="btn btn-sm">
												View sequence
											</button>
											<button type="button" className="btn btn-sm">
												Edit sequence
											</button>
										</div>
									</div>
								)}

								<div className="ob-quick-edit">
									<div className="ob-quick-edit-head">
										<IcoPencil />
										<span>Body · type to edit</span>
										<span className="ob-quick-edit-head-meta">
											{wordCount(draftBody(selected))} words ·{' '}
											{draftBody(selected).split('\n').length} lines
										</span>
									</div>
									<textarea
										aria-label="Email body"
										value={draftBody(selected)}
										onChange={(e) => patchEdit(selected.id, { body: e.target.value }, selected)}
									/>
									<div className="ob-quick-edit-foot">
										<span>
											<kbd>⌘</kbd>
											<kbd>S</kbd> save
										</span>
										<span>
											<kbd>⌘</kbd>
											<kbd>↵</kbd> approve &amp; send
										</span>
										<span>
											<kbd>⌘</kbd>
											<kbd>K</kbd> send to chat
										</span>
										{edits[selected.id]?.savedAt && (
											<span className="saved">Saved {edits[selected.id]?.savedAt}</span>
										)}
									</div>
								</div>
							</div>

							{/* Sticky action footer (action-bar-quick component) */}
							<div className="ob-actions" role="toolbar" aria-label="Draft actions">
								<div className="ob-actions-cluster">
									<button type="button" className="btn btn-sm btn-ghost" onClick={() => move(-1)}>
										<IcoBack />
										<span className="btn-label">Back</span>
									</button>
								</div>
								<div className="ob-actions-cluster">
									<button
										type="button"
										className="btn btn-sm"
										onClick={() => onSendToChat(selected.id)}
									>
										<IcoChat />
										<span className="btn-label">Send to chat</span>
									</button>
									<button
										type="button"
										className="btn btn-sm"
										onClick={() => onContinueSession(selected.id)}
									>
										<IcoContinue />
										<span className="btn-label">Continue Claude session</span>
									</button>
								</div>
								<div className="ob-actions-cluster">
									<button type="button" className="btn btn-sm" aria-label="Reschedule draft">
										<IcoClock />
										<span className="btn-label">Reschedule</span>
									</button>
									<button type="button" className="btn btn-sm" onClick={() => reject(selected.id)}>
										<IcoX />
										<span className="btn-label">Reject</span>
									</button>
								</div>
								<span className="ob-actions-spacer" />
								<span className="ob-actions-meta">
									→ sends to {selected.consequence.target} · {selected.consequence.recipients}{' '}
									{selected.consequence.recipients === 1 ? 'recipient' : 'recipients'} ·{' '}
									{selected.consequence.channel} · {selected.consequence.time} · undo{' '}
									{Math.round(selected.consequence.undoMs / 1000)}s
								</span>
								<button
									type="button"
									className="btn ob-actions-primary"
									aria-keyshortcuts="Meta+Enter"
									aria-label={consequence?.aria}
									title={consequence?.title}
									onClick={() => startApprove(selected)}
								>
									<IcoCheck />
									<span className="btn-label">Approve &amp; Send</span>
								</button>
							</div>
						</>
					) : (
						<div className="atelier-state is-empty" role="status">
							Select a draft to review
						</div>
					)}
				</div>
			</div>

			{undo && (
				<div className="ob-undo-toast" role="status">
					<span>
						Sending to{' '}
						{drafts.find((d) => d.id === undo.draftId)?.consequence.target ?? 'recipient'}…
					</span>
					<span className="ob-undo-toast-count">undo {undo.secondsLeft}s</span>
					<button type="button" className="btn btn-sm" onClick={cancelUndo}>
						Undo
					</button>
				</div>
			)}
		</section>
	);
}

// ── helpers ─────────────────────────────────────────────────────────────────────────────────

function groupBySection(drafts: PausedDraft[]): Array<[string, PausedDraft[]]> {
	const order = ['Overdue', 'Today', 'This week'];
	const map = new Map<string, PausedDraft[]>();
	for (const d of drafts) {
		const list = map.get(d.section) ?? [];
		list.push(d);
		map.set(d.section, list);
	}
	return [...map.entries()].sort((a, b) => {
		const ai = order.indexOf(a[0]);
		const bi = order.indexOf(b[0]);
		return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
	});
}

function initials(name: string): string {
	const parts = name
		.replace(/[^a-zA-ZÀ-ɏ ]/g, '')
		.trim()
		.split(/\s+/)
		.filter(Boolean);
	if (parts.length === 0) return '?';
	if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
	return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function wordCount(s: string): number {
	const t = s.trim();
	return t ? t.split(/\s+/).length : 0;
}

// The full consequence, carried onto the primary's tooltip + accessible name so
// the gate's safety premise (who/where/when + undo) survives even when the meta
// row is space-constrained. The "Approve & Send —" prefix keeps the visible CTA
// in the accessible name.
function consequenceStrings(d: PausedDraft): { title: string; aria: string } {
	const n = d.consequence.recipients;
	const word = n === 1 ? 'recipient' : 'recipients';
	const undoS = Math.round((d.consequence.undoMs ?? 10000) / 1000);
	return {
		title: `→ sends to ${d.consequence.target} · ${n} ${word} · ${d.consequence.channel} · ${d.fromProvider} · ${d.consequence.time} · ${undoS}s undo`,
		aria: `Approve & Send — to ${d.consequence.target}, ${n} ${word}, via ${d.consequence.channel}, ${d.consequence.time}, ${undoS} second undo`,
	};
}

function nowLabel(): string {
	const d = new Date();
	return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
