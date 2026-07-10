// WP-18c — Obi home live widgets.
//
// Query factories backing the four mock-data widget bodies on the home canvas
// (tasks / inbox / finance / boards). Reads go straight through the shell's
// local `db_query` Tauri command (`@/lib/tauri-cmd.dbQuery`) against the
// domain tables the honesty notes in
// `plans/atelier-parity/designs/parity-obi-home-live.html` grepped from the
// pkg queries — `tasks`, `email_messages` ⋈ `mail_thread_state`,
// `finance_alerts` / `latest_account_balances` / `transaction_ledger`.
//
// This is a shell-side read (not the pkg-iframe `host.dbQuery` bridge in
// `pkg-iframe-host.tsx`), so the `sqlite.tables` capability scope check does
// not apply here — same trust boundary `paActionsList` and every other
// shell-native query already relies on.

import { queryOptions } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';
import { dbQuery, pkgKernelStatus } from '@/lib/tauri-cmd';

// ───────────────────────── tasks ─────────────────────────

export interface HomeTaskRow {
	id: string;
	title: string;
	status: string;
	priority: string | null;
	due_date: string | null;
}

/**
 * Open tasks due today or earlier, blocked first then by priority. Real
 * vocabulary (grepped from `src-tauri/migrations/0025_tasks_domain.sql` +
 * `0049_task_signals.sql`): status is `pending` / `in_progress` / `blocked` /
 * `completed`; priority is `high` / `medium` / `low`. The design table's
 * `todo`/`done`/`snoozed` vocabulary was speculative — this uses the schema
 * that actually shipped.
 */
export function homeTasksQueryOptions() {
	return queryOptions({
		queryKey: queryKeys.home.tasks(),
		queryFn: () =>
			dbQuery<HomeTaskRow>(
				`SELECT id, title, status, priority, due_date
				 FROM tasks
				 WHERE status != 'completed'
				   AND due_date IS NOT NULL
				   AND date(due_date) <= date('now')
				 ORDER BY
				   CASE status WHEN 'blocked' THEN 0 ELSE 1 END,
				   CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END,
				   due_date ASC
				 LIMIT 6`
			),
		staleTime: 30_000,
	});
}

// ───────────────────────── inbox ─────────────────────────

export interface HomeInboxRow {
	id: string;
	from_address: string;
	subject: string | null;
	received_at: string;
	triage_category: string | null;
}

/**
 * Unread, un-snoozed threads newest-first — `email_messages` LEFT JOIN
 * `mail_thread_state` (0042_mail_domain.sql). A row with no thread-state at
 * all counts as unread (the pkg only upserts state on first touch).
 */
export function homeInboxQueryOptions() {
	return queryOptions({
		queryKey: queryKeys.home.inbox(),
		queryFn: () =>
			dbQuery<HomeInboxRow>(
				`SELECT em.id, em.from_address, em.subject, em.received_at, em.triage_category
				 FROM email_messages em
				 LEFT JOIN mail_thread_state mts ON mts.message_id = em.id
				 WHERE (mts.is_read IS NULL OR mts.is_read = 0)
				   AND (mts.snoozed_until IS NULL OR mts.snoozed_until <= datetime('now'))
				 ORDER BY em.received_at DESC
				 LIMIT 6`
			),
		staleTime: 30_000,
	});
}

// ───────────────────────── finance ─────────────────────────

export interface HomeFinanceAlert {
	id: string;
	type: string;
	severity: string;
	message: string;
}

export interface HomeFinanceSnapshot {
	/** Whether any of the three source tables have a single row. Distinguishes
	 *  "no finance data seeded at all" from "seeded but nothing due right now". */
	hasAnyData: boolean;
	/** USD-currency cash on hand. Deliberately NOT FX-converted — the local
	 *  `latest_account_balances` view (0033/0040) carries native-currency
	 *  balances only, and inventing an FX conversion here risks showing a
	 *  wrong number for real money. Documented simplification (see WP-18c
	 *  report); null when there are no USD accounts. */
	cashUsd: number | null;
	/** Net USD outflow over the trailing 30 days from `transaction_ledger`.
	 *  Positive = net cash out (burn); zero/negative = net cash in. Null when
	 *  there are no USD-denominated transactions in the window. */
	burnUsd30d: number | null;
	/** cashUsd / burnUsd30d, months. Null unless both cash and a positive burn
	 *  are known — never divides by zero or a negative/zero burn. */
	runwayMonths: number | null;
	/** Highest-severity open alert (crit before warn), most recent first. */
	topAlert: HomeFinanceAlert | null;
}

/** Placeholder target until finance ships a config surface for it (no table
 *  carries a runway target today — see honesty notes in the design source). */
export const RUNWAY_TARGET_MONTHS = 12;

export function homeFinanceQueryOptions() {
	return queryOptions({
		queryKey: queryKeys.home.finance(),
		queryFn: async (): Promise<HomeFinanceSnapshot> => {
			const [alertRows, cashRows, burnRows, anyAlerts, anyBalances, anyTxns] = await Promise.all([
				dbQuery<HomeFinanceAlert>(
					`SELECT id, type, severity, message
					 FROM finance_alerts
					 WHERE status = 'active'
					 ORDER BY CASE severity WHEN 'crit' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END, created_at DESC
					 LIMIT 1`
				),
				dbQuery<{ cash_usd: number | null }>(
					`SELECT SUM(CAST(balance_after AS REAL)) AS cash_usd
					 FROM latest_account_balances
					 WHERE currency = 'USD'`
				),
				dbQuery<{ net_usd_30d: number | null }>(
					`SELECT SUM(CAST(amount_usd AS REAL)) AS net_usd_30d
					 FROM transaction_ledger
					 WHERE amount_usd IS NOT NULL
					   AND currency = 'USD'
					   AND txn_date >= date('now', '-30 days')`
				),
				dbQuery<{ n: number }>(`SELECT COUNT(*) AS n FROM finance_alerts`),
				dbQuery<{ n: number }>(`SELECT COUNT(*) AS n FROM latest_account_balances`),
				dbQuery<{ n: number }>(`SELECT COUNT(*) AS n FROM transaction_ledger`),
			]);

			const cashUsd = cashRows[0]?.cash_usd ?? null;
			const netUsd30d = burnRows[0]?.net_usd_30d ?? null;
			// "Burn" is net cash OUT — a positive net_usd_30d means net cash IN,
			// which is not burn (runway is not computable/meaningful from it).
			const burnUsd30d = netUsd30d != null && netUsd30d < 0 ? -netUsd30d : null;
			const runwayMonths =
				cashUsd != null && burnUsd30d != null && burnUsd30d > 0 ? cashUsd / burnUsd30d : null;

			const hasAnyData =
				(anyAlerts[0]?.n ?? 0) > 0 || (anyBalances[0]?.n ?? 0) > 0 || (anyTxns[0]?.n ?? 0) > 0;

			return {
				hasAnyData,
				cashUsd,
				burnUsd30d,
				runwayMonths,
				topAlert: alertRows[0] ?? null,
			};
		},
		staleTime: 30_000,
	});
}

// ───────────────────────── boards ─────────────────────────

/**
 * Boards is the least-grounded widget (design honesty notes: the studio pkg's
 * board/frame query surface isn't finalized — open question for the founder,
 * storyboards vs strategic_initiatives). There is no boards/frames table in
 * `src-tauri/migrations/` to query, so this only checks whether
 * `com.ikenga.studio` is installed — a real, live signal — and the widget
 * body renders the honest "not installed" / "no query surface yet" states
 * around it rather than fabricating board rows.
 */
export function homeBoardsPkgStatusQueryOptions() {
	return queryOptions({
		queryKey: queryKeys.home.boardsPkgStatus(),
		queryFn: async () => {
			const status = await pkgKernelStatus();
			return status.installed.some((p) => p.id === 'com.ikenga.studio' && p.enabled);
		},
		staleTime: 30_000,
	});
}
