-- 0040_finance_view_deterministic — WP-10c: make latest_account_balances
-- deterministic.
--
-- The original Postgres view (008_latest_balances_view.sql) is
-- `SELECT DISTINCT ON (account_id) ... ORDER BY account_id, txn_date DESC,
-- created_at DESC` — a NON-UNIQUE sort: when an account has two rows on the same
-- txn_date AND the same created_at timestamp (real in the data — e.g. D-USD on
-- 2025-12-06 has two rows stamped identically), the "latest" pick is arbitrary
-- in BOTH Postgres and SQLite, and the two engines can choose differently.
--
-- 0033 reproduced the ambiguous ordering faithfully. This adds `id DESC` as a
-- final tie-break so the local view is deterministic + reproducible (and, for
-- the current data, agrees with the Supabase view on every account). The
-- underlying transaction_ledger is unchanged — this only stabilises a derived
-- convenience view.

DROP VIEW IF EXISTS latest_account_balances;

CREATE VIEW latest_account_balances AS
SELECT account_id, balance_after, currency, txn_date, created_at
FROM (
  SELECT
    account_id,
    balance_after,
    currency,
    txn_date,
    created_at,
    row_number() OVER (
      PARTITION BY account_id
      ORDER BY txn_date DESC, created_at DESC, id DESC
    ) AS _rn
  FROM transaction_ledger
  WHERE balance_after IS NOT NULL
)
WHERE _rn = 1;
