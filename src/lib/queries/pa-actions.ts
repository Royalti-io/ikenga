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
	return draft;
}
