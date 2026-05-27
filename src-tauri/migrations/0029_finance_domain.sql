-- 0029_finance_domain — Atelier/PA "finance / CFO" domain.
--
-- Down-mapped from royalti-pa Supabase migration 002_cfo_schema.sql:
--   bank_accounts, transaction_ledger, classification_rules, exchange_rates,
--   inter_company_entries, paystack_splits, receivables, cfo_processing_runs.
-- (agent_reports lives in 0025_tasks_domain.)
--
-- ALL numeric(p,s) money columns → TEXT (preserve precision; NEVER REAL for
-- money). date / time / timestamptz → TEXT. jsonb (raw_data, errors) → TEXT.
-- text[] (accounts_requested/completed) → TEXT (JSON-encoded). Cross-domain /
-- self FK REFERENCES dropped; columns kept as TEXT soft links.
--
-- NOTE: bank_account_balances is listed in PART A but has NO CREATE TABLE in
-- the source migrations (002 ships a `latest_account_balances` VIEW, not a
-- base table — 008_latest_balances_view.sql / referenced by 072). Views are
-- out of WP-02 scope (tables only). FLAGGED in the report; not emitted.
-- The 002 seed rows for bank_accounts (12 INSERTs) are NOT replayed here —
-- data load is WP-03's ETL job, not the schema migration.

CREATE TABLE IF NOT EXISTS bank_accounts (
  id TEXT PRIMARY KEY,
  account_name TEXT NOT NULL,
  entity TEXT NOT NULL,
  currency TEXT NOT NULL,
  bank TEXT NOT NULL,
  sheet_name TEXT,
  is_active INTEGER DEFAULT 1,
  created_at TEXT,
  updated_at TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS transaction_ledger (
  id TEXT PRIMARY KEY,
  source_ref TEXT,
  txn_date TEXT NOT NULL,
  txn_time TEXT,
  account_id TEXT NOT NULL,
  entity TEXT NOT NULL,
  type TEXT NOT NULL,
  amount TEXT NOT NULL,
  currency TEXT NOT NULL,
  amount_usd TEXT,
  balance_after TEXT,
  counterparty TEXT,
  description TEXT,
  payment_type TEXT,
  category TEXT,
  subcategory TEXT,
  classification_confidence TEXT,
  benefiting_entity TEXT,
  funding_source TEXT,
  reconciliation_status TEXT DEFAULT 'n/a',
  ledger_account TEXT,
  linked_txn_id TEXT,
  reconciliation_group TEXT,
  raw_data TEXT,
  notes TEXT,
  processed_at TEXT,
  created_at TEXT,
  updated_at TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS classification_rules (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 1,
  is_active INTEGER DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 100,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  subcategory TEXT,
  entity_scope TEXT,
  account_scope TEXT,
  pattern TEXT NOT NULL,
  match_field TEXT DEFAULT 'counterparty',
  notes TEXT,
  created_at TEXT,
  updated_at TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS exchange_rates (
  id TEXT PRIMARY KEY,
  rate_month TEXT NOT NULL UNIQUE,
  ngn_usd TEXT NOT NULL,
  eur_usd TEXT NOT NULL,
  gbp_usd TEXT NOT NULL,
  source TEXT DEFAULT 'manual',
  created_at TEXT,
  updated_at TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS inter_company_entries (
  id TEXT PRIMARY KEY,
  ledger_account TEXT NOT NULL,
  entry_date TEXT NOT NULL,
  source_entity TEXT NOT NULL,
  destination_entity TEXT NOT NULL,
  amount TEXT NOT NULL,
  currency TEXT NOT NULL,
  amount_usd TEXT,
  transfer_type TEXT NOT NULL,
  loan_status TEXT DEFAULT 'outstanding',
  running_balance_usd TEXT,
  source_txn_id TEXT,
  destination_txn_id TEXT,
  reconciliation_status TEXT DEFAULT 'pending',
  transfer_id TEXT UNIQUE,
  notes TEXT,
  created_at TEXT,
  updated_at TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS paystack_splits (
  id TEXT PRIMARY KEY,
  original_txn_id TEXT NOT NULL,
  split_date TEXT NOT NULL,
  total_ngn TEXT NOT NULL,
  total_usd TEXT NOT NULL,
  royalti_fee_ngn TEXT NOT NULL,
  royalti_fee_usd TEXT NOT NULL,
  dixtrit_portion_ngn TEXT NOT NULL,
  dixtrit_portion_usd TEXT NOT NULL,
  settlement_status TEXT DEFAULT 'pending',
  created_at TEXT,
  updated_at TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS receivables (
  id TEXT PRIMARY KEY,
  document_no TEXT UNIQUE NOT NULL,
  invoice_date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  customer TEXT NOT NULL,
  customer_email TEXT,
  customer_phone TEXT,
  description TEXT,
  coverage_period TEXT,
  total_amount TEXT NOT NULL,
  amount_paid TEXT DEFAULT '0',
  balance_left TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  invoice_status TEXT NOT NULL DEFAULT 'overdue',
  collection_status TEXT,
  collection_method TEXT,
  customer_type TEXT,
  source TEXT,
  last_contact_date TEXT,
  decision TEXT,
  decision_date TEXT,
  decided_by TEXT,
  notes TEXT,
  created_at TEXT,
  updated_at TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS cfo_processing_runs (
  id TEXT PRIMARY KEY,
  run_type TEXT NOT NULL,
  mode TEXT,
  status TEXT DEFAULT 'running',
  accounts_requested TEXT,
  accounts_completed TEXT,
  transactions_processed INTEGER DEFAULT 0,
  transactions_classified INTEGER DEFAULT 0,
  transactions_skipped INTEGER DEFAULT 0,
  errors TEXT,
  output_summary TEXT,
  triggered_by TEXT DEFAULT 'manual',
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT
) STRICT;
