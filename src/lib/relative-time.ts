/**
 * Human-readable relative timestamps for the chat surface (and anywhere
 * else that wants the same conventions).
 *
 * Mirrors the formatter in `design/shell/chat-redesign/2026-05-18-user-
 * turn-variants.html`. Pure function, no React dependency — render-side
 * callers should re-invoke it when they want fresh strings (a 1-minute
 * timer in the chat thread, for example).
 *
 * Buckets:
 *   < 1 min            → 'just now'
 *   < 2 min            → 'a min ago'
 *   < 60 min           → '8 mins ago'
 *   < 120 min          → 'an hour ago'
 *   < 24 hr            → '10:15 PM'
 *   < 48 hr            → 'yesterday'
 *   < 7 days           → 'Mon' (weekday abbreviation)
 *   < 14 days          → 'last week'
 *   else               → 'May 18' (month + day, locale-respecting)
 */

/** Format a millisecond timestamp relative to `now` (defaults to
 *  `Date.now()`). Negative `minutesAgo` is treated as 0 — future
 *  timestamps shouldn't happen, but they shouldn't blow up either. */
export function formatRelativeTime(timestampMs: number, now: number = Date.now()): string {
	const minutesAgo = Math.max(0, Math.floor((now - timestampMs) / 60_000));
	if (minutesAgo < 1) return 'just now';
	if (minutesAgo < 2) return 'a min ago';
	if (minutesAgo < 60) return `${minutesAgo} mins ago`;
	if (minutesAgo < 120) return 'an hour ago';
	const d = new Date(timestampMs);
	if (minutesAgo < 24 * 60) return formatClock(d);
	if (minutesAgo < 48 * 60) return 'yesterday';
	if (minutesAgo < 7 * 24 * 60) {
		return d.toLocaleDateString(undefined, { weekday: 'short' });
	}
	if (minutesAgo < 14 * 24 * 60) return 'last week';
	return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** 12-hour clock: `10:15 PM`. Padded minutes. Used by the < 24 hr bucket
 *  above; exported separately for callers that always want clock time. */
export function formatClock(d: Date): string {
	let h = d.getHours();
	const m = d.getMinutes().toString().padStart(2, '0');
	const ampm = h >= 12 ? 'PM' : 'AM';
	h = h % 12 || 12;
	return `${h}:${m} ${ampm}`;
}
