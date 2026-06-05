-- 0033_finance_views — WP-10a: recreate the finance derived view locally.
--
-- latest_account_balances is NOT a base table — it is a Postgres VIEW
-- (royalti-pa 008_latest_balances_view.sql) returning the most recent
-- balance_after per bank account over transaction_ledger (~12K rows). Live
-- introspection confirmed it: PostgREST OpenAPI exposes it with NO primary key
-- and the source migration is `CREATE OR REPLACE VIEW`. So it is recreated here
-- as a local view, NOT ETL'd — its rows are derived from transaction_ledger
-- (0029), which the WP-10 finance ETL backfills with full row+PK parity. The
-- view's row count therefore matches Supabase automatically once that ETL lands.
--
-- Postgres `SELECT DISTINCT ON (account_id) ... ORDER BY account_id,
-- txn_date DESC, created_at DESC` has no SQLite equivalent; the row_number()
-- window below is the exact semantic translation (SQLite ≥ 3.25).

CREATE VIEW IF NOT EXISTS latest_account_balances AS
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
      ORDER BY txn_date DESC, created_at DESC
    ) AS _rn
  FROM transaction_ledger
  WHERE balance_after IS NOT NULL
)
WHERE _rn = 1;
