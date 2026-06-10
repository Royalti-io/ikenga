import {
	type ApproveGateMeta,
	type DraftItem,
	fromDraftItem,
	type PausedDraft,
} from '@ikenga/contract';
import { queryOptions } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';
import { type PaActionDraftRow, paActionsList } from '@/lib/tauri-cmd';

/** TanStack Query options for the gate's active draft set (or a status filter). */
export function paActionsListQueryOptions(status?: string) {
	return queryOptions({
		queryKey: queryKeys.paActions.list(status),
		queryFn: () => paActionsList(status),
		staleTime: 10_000,
	});
}

/**
 * Parse one `pa_action_drafts` row into the panel's `PausedDraft` view-model.
 *
 * Producer contract: `payloadJson` is `{ item: DraftItem, meta: ApproveGateMeta }`
 * (the producer writes it via `host.paActionsPause`); `editedJson` is the
 * operator's `{ subject?, body? }` overrides. Returns `null` on malformed JSON so
 * the caller can skip the row rather than crash the gate.
 *
 * WP-12 / G-09: reads `row.status`, `row.errorText`, and `row.attempts` from the
 * DB row and stamps them onto the view-model so the panel can surface failed rows
 * with their error callout and Retry button. `fromDraftItem` derives its own
 * overdue/today status from the scheduled time; we override with `'failed'` only
 * when the DB row is actually in the `failed` state.
 */
export function pausedDraftFromRow(row: PaActionDraftRow): PausedDraft | null {
	let parsed: { item?: DraftItem; meta?: ApproveGateMeta };
	try {
		parsed = JSON.parse(row.payloadJson) as { item?: DraftItem; meta?: ApproveGateMeta };
	} catch {
		return null;
	}
	if (!parsed?.item || !parsed?.meta) return null;

	let item = parsed.item;
	let edited = false;
	if (row.editedJson) {
		try {
			const patch = JSON.parse(row.editedJson) as { subject?: string; body?: string };
			item = {
				...item,
				subject: patch.subject ?? item.subject,
				body: patch.body ?? item.body,
			};
			edited = true;
		} catch {
			// malformed edit patch — fall back to the original draft
		}
	}

	const draft = fromDraftItem(item, parsed.meta);
	if (edited) {
		draft.everEdited = true;
		if (draft.status === 'awaiting') draft.status = 'edited';
	}

	// WP-12 / G-09 — propagate DB-side status onto the view-model.
	// `failed` is the only status that originates from the worker (not the FE) and
	// needs to override fromDraftItem's derived status.
	if (row.status === 'failed') {
		draft.status = 'failed';
	}
	// Surface worker-written error context so the panel can render the callout.
	if (row.errorText != null) {
		draft.errorMessage = row.errorText;
	}
	if (row.attempts > 0) {
		draft.attempts = row.attempts;
	}

	return draft;
}
